import { useEffect, useRef } from 'react';
import CryptoJS from 'crypto-js';

class XfVoiceDictation {
    constructor(opts = {}) {
        // 服务接口认证信息(语音听写（流式版）WebAPI)
        this.APPID = opts.APPID || '';
        this.APISecret = opts.APISecret || '';
        this.APIKey = opts.APIKey || '';

        // webSocket请求地址
        this.url = opts.url || 'wss://iat.xf-yun.com/v1';
        this.host = opts.host || 'iat.xf-yun.com';

        // 识别监听方法
        this.onTextChange = opts.onTextChange || Function();
        this.onWillStatusChange = opts.onWillStatusChange || Function();
        this.onError = opts.onError
            ? (error) => {
                if (typeof opts.onError === 'function') {
                    setTimeout(() => opts.onError(error), 0);
                }
            }
            : Function();

        // 方言/语种
        this.status = 'null';
        this.language = opts.language || 'zh_cn';
        this.accent = opts.accent || 'mandarin';

        // 流媒体
        this.streamRef = [];
        this.audioData = [];
        this.resultText = '';
        this.textSegments = []; // 存储文本片段

        this.init();
    }

    // 获取webSocket请求地址鉴权
    getWebSocketUrl() {
        return new Promise((resolve, reject) => {
            const { url, host, APISecret, APIKey } = this;
            try {
                let date = new Date().toGMTString(),
                    algorithm = 'hmac-sha256',
                    headers = 'host date request-line',
                    signatureOrigin = `host: ${host}\ndate: ${date}\nGET /v1 HTTP/1.1`,
                    signatureSha = CryptoJS.HmacSHA256(signatureOrigin, APISecret),
                    signature = CryptoJS.enc.Base64.stringify(signatureSha),
                    authorizationOrigin = `api_key="${APIKey}", algorithm="${algorithm}", headers="${headers}", signature="${signature}"`,
                    encoder = new TextEncoder();
                const authorization = btoa(String.fromCharCode.apply(null, encoder.encode(authorizationOrigin)));
                resolve(`${url}?authorization=${authorization}&date=${date}&host=${host}`);
            } catch (error) {
                reject(error);
            }
        });
    }

    init() {
        try {
            if (!this.APPID || !this.APIKey || !this.APISecret) {
                this.onError('请正确配置【迅飞语音听写（流式版）WebAPI】服务接口认证信息！');
            } else {
                this.webWorker = new Worker(new URL('./transcode.worker.js', import.meta.url));  // Ensure correct path for the worker
                this.webWorker.onmessage = (event) => {
                    this.audioData.push(...event.data);
                };
            }
        } catch (error) {
            this.onError('对不起：请在服务器环境下运行！');
            console.error('请在服务器环境中运行！', error);
        }
    }

    setStatus(status) {
        this.onWillStatusChange && this.status !== status && this.onWillStatusChange(this.status, status);
        this.status = status;
    }

    setResultText({ resultText } = {}) {
        // 总是传递完整的resultText给onTextChange
        this.onTextChange && this.onTextChange(resultText || '');
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
            let iatWS;
            if ('WebSocket' in window) {
                iatWS = new WebSocket(url);
            } else if ('MozWebSocket' in window) {
                iatWS = new MozWebSocket(url);
            } else {
                this.onError('浏览器不支持WebSocket!');
                return false;
            }
            this.webSocket = iatWS;
            this.setStatus('init');
            iatWS.onopen = (e) => {
                this.setStatus('ing');
                setTimeout(() => {
                    this.webSocketSend();
                }, 500);
            };
            iatWS.onmessage = (e) => {
                this.webSocketRes(e.data);
            };
            iatWS.onerror = (e) => {
                this.recorderStop();
            };
            iatWS.onclose = (e) => {
                this.recorderStop();
            };
        });
    }

    webSocketSend() {
        if (this.webSocket.readyState !== 1) return false;
        const audioData = this.audioData.splice(0, 1280);
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
                    audio: this.toBase64(audioData),
                },
            },
        };
        this.webSocket.send(JSON.stringify(params));
        this.handlerInterval = setInterval(() => {
            if (this.audioData.length === 0) {
                return false;
            }
            this.webSocket.send(
                JSON.stringify({
                    header: {
                        app_id: this.APPID,
                        status: 1,
                    },
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
        let result = '';
        let currentSentence = '';
        let lastRplText = '';

        data.forEach((item) => {
            if (item.pgs === 'apd') {
                // 如果之前有 pending `rpl`，使用它
                if (lastRplText) {
                    result += lastRplText;
                    lastRplText = ''; // 重置
                } else {
                    result += currentSentence; // 直接使用 `apd`
                }
                currentSentence = item.text; // 新句子开始
            } else if (item.pgs === 'rpl') {
                lastRplText = item.text; // 记录最新的 `rpl`，但不立即应用
            }
        });

        // 处理最后可能剩余的 `rpl` 或 `apd`
        if (lastRplText) {
            result += lastRplText;
        } else {
            result += currentSentence;
        }

        return result;
    }

    webSocketRes(resultData) {
        try {
            let jsonData = JSON.parse(resultData);

            // 处理错误状态
            if (jsonData.header?.code !== 0) {
                this.onError(`语音识别错误: ${jsonData.header?.message || '未知错误'}`);
                this.webSocket.close();
                return;
            }

            // 处理正常返回结果
            if (jsonData.payload?.result) {
                try {
                    const text = this.base64ToUtf8(jsonData.payload.result.text);
                    const result = JSON.parse(text);

                    // 处理分片文本
                    if (result.ws) {
                        const current = result.ws.map((element) =>
                            element.cw.map(cw => cw.w).join('')
                        ).join('');
                        this.textSegments.push({ pgs: result.pgs, text: current })
                        const finalText = this.concatText(this.textSegments);
                        this.setResultText({
                            resultText: finalText,
                        });
                        // 根据状态处理
                        if (jsonData.header.status === 2 || result.ls === true) { // 结束
                            this.setStatus('end');
                        }
                    }
                } catch (e) {
                    this.onError(`解析语音结果失败: ${e.message}`);
                }
            }

            // 处理结束状态
            if (jsonData.header?.status === 2) {
                this.webSocket.close();
            }
        } catch (error) {
            this.onError(`处理WebSocket数据失败: ${error.message}`);
        }
    }

    recorderInit() {
        try {
            this.audioContext = this.audioContext
                ? this.audioContext
                : new (window.AudioContext || window.webkitAudioContext)();
            this.audioContext.resume();
            if (!this.audioContext) {
                this.onError('浏览器不支持webAudioApi相关接口');
                return false;
            }
        } catch (e) {
            this.onError('浏览器不支持webAudioApi相关接口');
            return false;
        }

        let getMediaSuccess = (_) => {
            this.scriptProcessor = this.audioContext.createScriptProcessor(0, 1, 1);
            this.scriptProcessor.onaudioprocess = (e) => {
                if (this.status === 'ing') {
                    try {
                        this.webWorker.postMessage(e.inputBuffer.getChannelData(0));
                    } catch (error) { }
                }
            };
            this.mediaSource = this.audioContext.createMediaStreamSource(this.streamRef);
            this.mediaSource.connect(this.scriptProcessor);
            this.scriptProcessor.connect(this.audioContext.destination);
            this.connectWebSocket();
        };

        let getMediaFail = (e) => {
            this.onError('录音权限获取失败!');
            this.audioContext && this.audioContext.close();
            this.audioContext = undefined;
            if (this.webSocket && this.webSocket.readyState === 1) {
                this.webSocket.close();
            }
        };

        navigator.getUserMedia =
            navigator.getUserMedia ||
            navigator.webkitGetUserMedia ||
            navigator.mozGetUserMedia ||
            navigator.msGetUserMedia;
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            navigator.mediaDevices
                .getUserMedia({
                    audio: true,
                })
                .then((stream) => {
                    this.streamRef = stream;
                    getMediaSuccess();
                })
                .catch((e) => {
                    getMediaFail(e);
                });
        } else if (navigator.getUserMedia) {
            navigator.getUserMedia(
                {
                    audio: true,
                },
                (stream) => {
                    this.streamRef = stream;
                    getMediaSuccess();
                },
                (e) => {
                    getMediaFail(e);
                }
            );
        } else {
            if (
                navigator.userAgent.toLowerCase().match(/chrome/) &&
                location.origin.indexOf('https://') < 0
            ) {
                console.error(
                    '需要在localhost或127.0.0.1或https下才能获取录音权限！'
                );
            } else {
                this.onError('未识别到录音设备!');
            }
            this.audioContext && this.audioContext.close();
            return false;
        }
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
        if (!/Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent)) {
            this.audioContext && this.audioContext.suspend();
        }
        try {
            // 发送最终消息
            if (this.webSocket && this.webSocket.readyState === 1) {
                this.webSocket.send(
                    JSON.stringify({
                        header: {
                            app_id: this.APPID,
                            status: 2,
                        },
                        payload: {
                            audio: {
                                encoding: 'raw',
                                sample_rate: 16000,
                                channels: 1,
                                bit_depth: 16,
                                seq: 591,
                                status: 2,
                                audio: this.toBase64(audioData),
                            },
                        },
                    })
                );
            }
            this.audioData = [];
            clearInterval(this.handlerInterval);
        } catch (error) {
            console.error('暂停失败!');
        }
    }

    start() {
        this.recorderStart();
        this.textSegments = [];
        this.setResultText({ resultText: '' });
        // 设置60秒倒计时，超时自动停止
        if (this.countdownTimer) {
            clearTimeout(this.countdownTimer);
        }
        this.countdownTimer = setTimeout(() => {
            if (this.status === 'ing') {
                this.recorderStop();
            }
        }, 60000);
    }

    stop() {
        if (this.countdownTimer) {
            clearTimeout(this.countdownTimer);
            this.countdownTimer = null;
        }
        this.recorderStop();
    }
}

export const useXfVoiceDictation = (opts) => {
    const voiceRef = useRef(null);
    useEffect(() => {
        voiceRef.current = new XfVoiceDictation(opts);

        return () => {
            voiceRef.current?.stop();
            voiceRef.current?.webSocket?.close(); // Close WebSocket if it's still open
            voiceRef.current?.webWorker?.terminate(); // Clean up the web worker
        };
    }, [opts]);

    return voiceRef.current;
};

export default XfVoiceDictation;
