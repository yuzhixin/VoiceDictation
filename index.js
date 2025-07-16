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
        this.onError = opts.onError
            ? (error) => {
                if (typeof opts.onError === 'function') {
                    setTimeout(() => opts.onError(error), 0);
                }
            }
            : Function();

        this.status = 'null';
        this.language = opts.language || 'zh_cn';
        this.accent = opts.accent || 'mandarin';

        this.streamRef = null;
        this.audioData = [];
        this.resultText = '';
        this.textSegments = [];

        this.init();
    }

    getWebSocketUrl() {
        return new Promise((resolve, reject) => {
            const { url, host, APISecret, APIKey } = this;
            try {
                const date = new Date().toGMTString();
                const algorithm = 'hmac-sha256';
                const headers = 'host date request-line';
                const signatureOrigin = `host: ${host}\ndate: ${date}\nGET /v1 HTTP/1.1`;
                const signatureSha = CryptoJS.HmacSHA256(signatureOrigin, APISecret);
                const signature = CryptoJS.enc.Base64.stringify(signatureSha);
                const authorizationOrigin = `api_key="${APIKey}", algorithm="${algorithm}", headers="${headers}", signature="${signature}"`;
                const encoder = new TextEncoder();
                const authorization = btoa(String.fromCharCode.apply(null, encoder.encode(authorizationOrigin)));
                resolve(`${url}?authorization=${authorization}&date=${date}&host=${host}`);
            } catch (error) {
                reject(error);
            }
        });
    }

    init() {
        if (!this.APPID || !this.APIKey || !this.APISecret) {
            this.onError('请正确配置【迅飞语音听写（流式版）WebAPI】服务接口认证信息！');
            return;
        }
        try {
            this.webWorker = new Worker(new URL('./transcode.worker.js', import.meta.url));
            this.webWorker.onmessage = (event) => {
                this.audioData.push(...event.data);
            };
        } catch (error) {
            this.onError('对不起：请在服务器环境下运行！');
        }
    }

    setStatus(status) {
        if (this.status !== status) {
            this.onWillStatusChange(this.status, status);
            this.status = status;
        }
    }

    setResultText({ resultText } = {}) {
        this.onTextChange(resultText || '');
    }

    setParams({ language, accent } = {}) {
        language && (this.language = language);
        accent && (this.accent = accent);
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

    connectWebSocket() {
        return this.getWebSocketUrl().then((url) => {
            let iatWS = 'WebSocket' in window ? new WebSocket(url) :
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
            iatWS.onerror = () => this.recorderStop();
            iatWS.onclose = () => this.recorderStop();
        });
    }

    webSocketSend() {
        if (this.webSocket.readyState !== 1) return;

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

    recorderInit() {
        try {
            this.audioContext = this.audioContext || new (window.AudioContext || window.webkitAudioContext)();
            this.audioContext.resume();
        } catch {
            this.onError('浏览器不支持webAudioApi相关接口');
            return;
        }

        const getMediaSuccess = (stream) => {
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
            this.connectWebSocket();
        };

        const getMediaFail = () => {
            this.onError('录音权限获取失败!');
            this.audioContext?.close();
            this.audioContext = null;
            this.webSocket?.close();
        };

        navigator.mediaDevices?.getUserMedia({ audio: true })
            .then(getMediaSuccess)
            .catch(getMediaFail);
    }

    recorderStart() {
        if (!this.audioContext) {
            this.recorderInit();
        } else {
            this.audioContext.resume();
            this.connectWebSocket();
        }
    }

    recorderStop() {
        try {
            if (this.status === 'ing' && this.webSocket?.readyState === 1) {
                this.webSocket.send(JSON.stringify({
                    header: { app_id: this.APPID, status: 2 },
                    payload: {
                        audio: {
                            encoding: 'raw',
                            sample_rate: 16000,
                            channels: 1,
                            bit_depth: 16,
                            seq: 591,
                            status: 2,
                            audio: this.toBase64(this.audioData),
                        },
                    },
                }));
            }
        } catch (error) {
            console.error('发送终止包失败!', error);
        }
        this.setStatus('end');
        this.destroy(); // ✅ 统一清理
    }

    destroy() {
        if (this.streamRef?.getTracks) {
            this.streamRef.getTracks().forEach((track) => track.stop());
            this.streamRef = null;
        }
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

        this.webSocket?.close();
        this.webSocket = null;

        this.webWorker?.terminate();
        this.webWorker = null;

        this.audioData = [];
        this.textSegments = [];
        this.resultText = '';
    }

    start() {
        this.recorderStart();
        this.textSegments = [];
        this.setResultText({ resultText: '' });
        clearTimeout(this.countdownTimer);
        this.countdownTimer = setTimeout(() => {
            if (this.status === 'ing') {
                this.recorderStop();
            }
        }, 60000);
    }

    stop() {
        this.recorderStop();
    }
}

export const useXfVoiceDictation = (opts) => {
    const voiceRef = useRef(null);
    useEffect(() => {
        voiceRef.current = new XfVoiceDictation(opts);
        return () => {
            voiceRef.current?.stop();
            voiceRef.current?.destroy();
        };
    }, [opts]);
    return voiceRef;
};

export default XfVoiceDictation;
