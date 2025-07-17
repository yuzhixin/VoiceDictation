import { useEffect, useRef } from 'react';
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
        this.onError = typeof opts.onError === 'function'
            ? (error) => setTimeout(() => opts.onError(error), 0)
            : Function();

        this.language = opts.language || 'zh_cn';
        this.accent = opts.accent || 'mandarin';

        this.status = 'idle'; // 'idle' | 'ing' | 'end'
        this.resetInternal();
    }

    resetInternal() {
        // 只重置内部状态，不处理资源释放
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

    // 音频数据处理工具方法
    _processAudioData(buffer, encode = true) {
        if (encode) {
            let binary = '';
            let bytes = new Uint8Array(buffer);
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            return window.btoa(binary);
        } else {
            try {
                const binaryStr = atob(buffer);
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
    }

    toBase64(buffer) {
        return this._processAudioData(buffer, true);
    }

    base64ToUtf8(base64Str) {
        return this._processAudioData(base64Str, false);
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

            // 注册并加载AudioWorklet
            const processorUrl = new URL('./audio-processor.js', import.meta.url);
            await this.audioContext.audioWorklet.addModule(processorUrl);
            this.audioWorkletNode = new AudioWorkletNode(this.audioContext, 'audio-processor');

            this.audioWorkletNode.port.onmessage = (e) => {
                if (this.status === 'ing') {
                    this.webWorker.postMessage(e.data);
                }
            };

            this.mediaSource = this.audioContext.createMediaStreamSource(stream);
            this.mediaSource.connect(this.audioWorkletNode);
            this.audioWorkletNode.connect(this.audioContext.destination);

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
        if (this.status === 'ing' && this.webSocket?.readyState === 1) {
            try {
                this._sendWebSocketMessage(2, 999, this.audioData);
            } catch (e) {
                console.warn('发送最终包失败:', e);
            }
        }
        this.destroy();
    }

    destroy() {
        this.setStatus('end');

        // 释放所有资源
        this.webSocket?.close();
        this.webWorker?.terminate();
        this.streamRef?.getTracks?.().forEach(track => track.stop());
        clearInterval(this.handlerInterval);
        clearTimeout(this.countdownTimer);
        this.scriptProcessor?.disconnect();
        this.audioWorkletNode?.disconnect();
        this.mediaSource?.disconnect();
        this.audioContext?.close();

        // 重置所有引用和状态
        this.webSocket = null;
        this.webWorker = null;
        this.streamRef = null;
        this.handlerInterval = null;
        this.countdownTimer = null;
        this.scriptProcessor = null;
        this.audioWorkletNode = null;
        this.mediaSource = null;
        this.audioContext = null;

        this.resetInternal(); // 重置内部状态
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
        iatWS.onopen = () => {
            setTimeout(() => {
                this.webSocketSend()
            }, 500);
        };

        iatWS.onmessage = (e) => this.webSocketRes(e.data);
        iatWS.onerror = () => this.stop();
        iatWS.onclose = () => this.stop();
    }

    _sendWebSocketMessage(status, seq, audioData) {
        const params = {
            header: { app_id: this.APPID, status },
            payload: {
                audio: {
                    encoding: 'raw',
                    sample_rate: 16000,
                    channels: 1,
                    bit_depth: 16,
                    seq,
                    status,
                    audio: this.toBase64(audioData),
                },
            },
        };
        if (status === 0) {
            params.parameter = {
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
            };
        }
        return JSON.stringify(params);
    }

    webSocketSend() {
        if (this.webSocket.readyState !== 1 || this.status === "end") return;

        // 发送初始包
        if (this.status === "idle") {
            this.webSocket.send(
                this._sendWebSocketMessage(0, 1, this.audioData.splice(0, 1280))
            );
            this.setStatus("ing");
        }

        // 设置40ms定时器持续发送
        if (!this.handlerInterval) {
            this.handlerInterval = setInterval(() => {
                if (this.audioData.length > 0 && this.status === "ing") {
                    this.webSocket.send(
                        this._sendWebSocketMessage(1, 2, this.audioData.splice(0, 1280))
                    );
                }
            }, 40);
        }
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

    useEffect(() => {
        voiceRef.current = new XfVoiceDictation(opts);
        return () => {
            voiceRef.current?.stop();
        };
    }, [opts]);

    return voiceRef;
};

export default XfVoiceDictation;
