import { useEffect, useRef, useState } from 'react';
import CryptoJS from 'crypto-js';

class XfVoiceDictation {
    constructor(opts = {}) {
        this.APPID = opts.APPID || '';
        this.APISecret = opts.APISecret || '';
        this.APIKey = opts.APIKey || '';
        this.url = opts.url || 'wss://iat.xf-yun.com/v1';
        this.host = opts.host || 'iat.xf-yun.com';

        this.onTextChange = opts.onTextChange || Function();
        this.onWillStatusChange = opts.onWillStatusChange || Function();
        this.onRecordStatusChange = opts.onRecordStatusChange || Function();
        this.onError = typeof opts.onError === 'function'
            ? (error) => setTimeout(() => opts.onError(error), 0)
            : Function();

        this.language = opts.language || 'zh_cn';
        this.accent = opts.accent || 'mandarin';

        this.status = 'idle'; // 'idle' | 'ing' | 'end'
        this.resetInternal();
    }

    resetInternal() {
        this.webSocket = null;
        this.webWorker = null;
        this.audioContext = null;
        this.scriptProcessor = null;
        this.mediaSource = null;
        this.streamRef = null;

        this.handlerInterval = null;
        this.countdownTimer = null;

        this.audioData = [];
        this.textSegments = [];
        this.resultText = '';
    }

    setStatus(status) {
        if (this.status !== status) {
            this.onWillStatusChange(this.status, status);
            this.status = status;
        }
    }

    setResultText({ resultText } = {}) {
        this.resultText = resultText || '';
        this.onTextChange(this.resultText);
    }

    toBase64(buffer) {
        let binary = '';
        let bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
    }

    base64ToUtf8(base64Str) {
        try {
            const binaryStr = atob(base64Str);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) {
                bytes[i] = binaryStr.charCodeAt(i);
            }
            return new TextDecoder('utf-8').decode(bytes);
        } catch (error) {
            this.onError(`Base64解码失败: ${error.message}`);
            return '';
        }
    }

    getWebSocketUrl() {
        return new Promise((resolve, reject) => {
            try {
                const date = new Date().toGMTString();
                const signatureOrigin = `host: ${this.host}\ndate: ${date}\nGET /v1 HTTP/1.1`;
                const signatureSha = CryptoJS.HmacSHA256(signatureOrigin, this.APISecret);
                const signature = CryptoJS.enc.Base64.stringify(signatureSha);
                const authorizationOrigin = `api_key="${this.APIKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
                const encoder = new TextEncoder();
                const authorization = btoa(String.fromCharCode(...encoder.encode(authorizationOrigin)));
                resolve(`${this.url}?authorization=${authorization}&date=${date}&host=${this.host}`);
            } catch (error) {
                reject(error);
            }
        });
    }

    async start() {
        this.stop(); // 停止旧的并清理资源
        this.onRecordStatusChange('started');

        if (!this.APPID || !this.APIKey || !this.APISecret) {
            this.onError('请正确配置【迅飞语音听写 WebAPI】服务接口认证信息！');
            return;
        }

        this.resetInternal();
        this.setStatus('idle');
        this.setResultText({ resultText: '' });

        try {
            // 初始化 worker
            this.webWorker = new Worker(new URL('./transcode.worker.js', import.meta.url));
            this.webWorker.onmessage = (event) => {
                this.audioData.push(...event.data);
            };

            // 初始化音频
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            await this.audioContext.resume();
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.streamRef = stream;

            this.scriptProcessor = this.audioContext.createScriptProcessor(0, 1, 1);
            this.scriptProcessor.onaudioprocess = (e) => {
                if (this.status === 'ing') {
                    this.webWorker.postMessage(e.inputBuffer.getChannelData(0));
                }
            };

            this.mediaSource = this.audioContext.createMediaStreamSource(stream);
            this.mediaSource.connect(this.scriptProcessor);
            this.scriptProcessor.connect(this.audioContext.destination);

            await this.connectWebSocket();

            this.countdownTimer = setTimeout(() => {
                if (this.status === 'ing') {
                    this.stop();
                }
            }, 60000);
        } catch (error) {
            this.onError(`启动失败: ${error.message}`);
            this.stop();
        }
    }

    stop() {
        this.onRecordStatusChange('stopped');
        if (this.status === 'ing' && this.webSocket?.readyState === 1) {
            try {
                this.webSocket.send(JSON.stringify({
                    header: { app_id: this.APPID, status: 2 },
                    payload: {
                        audio: {
                            encoding: 'raw',
                            sample_rate: 16000,
                            channels: 1,
                            bit_depth: 16,
                            seq: 999,
                            status: 2,
                            audio: this.toBase64(this.audioData),
                        },
                    },
                }));
            } catch (e) {
                console.warn('发送最终包失败:', e);
            }
        }
        this.destroy();
    }

    destroy() {
        this.setStatus('end');

        this.webSocket?.close();
        this.webSocket = null;

        this.webWorker?.terminate();
        this.webWorker = null;

        this.streamRef?.getTracks?.().forEach(track => track.stop());
        this.streamRef = null;

        clearInterval(this.handlerInterval);
        clearTimeout(this.countdownTimer);
        this.handlerInterval = null;
        this.countdownTimer = null;

        this.scriptProcessor?.disconnect();
        this.mediaSource?.disconnect();
        this.scriptProcessor = null;
        this.mediaSource = null;

        this.audioContext?.close();
        this.audioContext = null;

        this.audioData = [];
        this.textSegments = [];
        this.resultText = '';
    }

    async connectWebSocket() {
        const url = await this.getWebSocketUrl();

        const iatWS = 'WebSocket' in window ? new WebSocket(url) :
            'MozWebSocket' in window ? new MozWebSocket(url) : null;

        if (!iatWS) {
            this.onError('浏览器不支持WebSocket!');
            return;
        }

        this.webSocket = iatWS;
        this.setStatus('init');

        iatWS.onopen = () => {
            this.setStatus('ing');
            setTimeout(() => this.webSocketSend(), 500);
        };

        iatWS.onmessage = (e) => this.webSocketRes(e.data);
        iatWS.onerror = () => this.stop();
        iatWS.onclose = () => this.stop();
    }

    webSocketSend() {
        if (this.webSocket.readyState !== 1 || this.status === "end") return;

        const params = {
            header: {
                app_id: this.APPID,
                status: 0,
            },
            parameter: {
                iat: {
                    domain: 'slm',
                    language: this.language,
                    accent: this.accent,
                    eos: 6000,
                    vinfo: 1,
                    dwa: 'wpgs',
                    result: {
                        encoding: 'utf8',
                        compress: 'raw',
                        format: 'json',
                    },
                },
            },
            payload: {
                audio: {
                    encoding: 'raw',
                    sample_rate: 16000,
                    channels: 1,
                    bit_depth: 16,
                    seq: 1,
                    status: 0,
                    audio: this.toBase64(this.audioData.splice(0, 1280)),
                },
            },
        };
        this.webSocket.send(JSON.stringify(params));

        this.handlerInterval = setInterval(() => {
            if (this.audioData.length === 0) return;
            this.webSocket.send(
                JSON.stringify({
                    header: { app_id: this.APPID, status: 1 },
                    payload: {
                        audio: {
                            encoding: 'raw',
                            sample_rate: 16000,
                            channels: 1,
                            bit_depth: 16,
                            seq: 2,
                            status: 1,
                            audio: this.toBase64(this.audioData.splice(0, 1280)),
                        },
                    },
                })
            );
        }, 40);
    }

    concatText(data) {
        let result = '', currentSentence = '', lastRplText = '';
        data.forEach((item) => {
            if (item.pgs === 'apd') {
                result += lastRplText || currentSentence;
                currentSentence = item.text;
                lastRplText = '';
            } else if (item.pgs === 'rpl') {
                lastRplText = item.text;
            }
        });
        return result + (lastRplText || currentSentence);
    }

    webSocketRes(resultData) {
        try {
            const jsonData = JSON.parse(resultData);

            if (jsonData.header?.code !== 0) {
                this.onError(`语音识别错误: ${jsonData.header?.message || '未知错误'}`);
                this.webSocket?.close();
                return;
            }

            if (jsonData.payload?.result) {
                const text = this.base64ToUtf8(jsonData.payload.result.text);
                const result = JSON.parse(text);

                if (result.ws) {
                    const current = result.ws.map(ws => ws.cw.map(cw => cw.w).join('')).join('');
                    this.textSegments.push({ pgs: result.pgs, text: current });
                    const finalText = this.concatText(this.textSegments);
                    this.setResultText({ resultText: finalText });

                    if (jsonData.header.status === 2 || result.ls === true) {
                        this.setStatus('end');
                    }
                }
            }

            if (jsonData.header?.status === 2) {
                this.webSocket?.close();
            }
        } catch (error) {
            this.onError(`处理WebSocket数据失败: ${error.message}`);
        }
    }
}

export const useXfVoiceDictation = (opts) => {
    const voiceRef = useRef(null);
    const [recordStatus, setRecordStatus] = useState('stopped');

    useEffect(() => {
        const instance = new XfVoiceDictation({
            ...opts,
            onRecordStatusChange: (status) => {
                setRecordStatus(status);
            },
            onWillStatusChange: (oldStatus, newStatus) => {
                opts.onWillStatusChange?.(oldStatus, newStatus);
            },
            onTextChange: (text) => {
                opts.onTextChange?.(text);
            },
            onError: (error) => {
                opts.onError?.(error);
            }
        });

        voiceRef.current = instance;
        return () => {
            voiceRef.current?.stop();
        };
    }, [opts]);

    return { voiceRef, recordStatus };
};

export default XfVoiceDictation;
