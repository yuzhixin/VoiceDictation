import { useEffect, useRef } from 'react';

class XfVoiceDictation {
    constructor(opts = {}) {
        // 服务接口认证信息(语音听写（流式版）WebAPI)
        this.APPID = opts.APPID || '';
        this.APISecret = opts.APISecret || '';
        this.APIKey = opts.APIKey || '';

        // webSocket请求地址
        this.url = opts.url || "wss://iat.xf-yun.com/v1";
        this.host = opts.host || "iat.xf-yun.com";

        // 识别监听方法
        this.onTextChange = opts.onTextChange || Function();
        this.onWillStatusChange = opts.onWillStatusChange || Function();
        this.onError = opts.onError ? (error) => {
            if (typeof opts.onError === 'function') {
                setTimeout(() => opts.onError(error), 0);
            }
        } : Function();

        // 方言/语种
        this.status = 'null'
        this.language = opts.language || 'zh_cn'
        this.accent = opts.accent || 'mandarin';

        // 流媒体
        this.streamRef = [];
        this.audioData = [];
        this.resultText = '';
        this.resultTextTemp = '';

        this.init();
    }

    // 获取webSocket请求地址鉴权
    getWebSocketUrl() {
        return new Promise((resolve, reject) => {
            const { url, host, APISecret, APIKey } = this;
            try {
                const CryptoJS = require('crypto-js');
                let date = new Date().toGMTString(),
                    algorithm = 'hmac-sha256',
                    headers = 'host date request-line',
                    signatureOrigin = `host: ${host}\ndate: ${date}\nGET /v1 HTTP/1.1`,
                    signatureSha = CryptoJS.HmacSHA256(signatureOrigin, APISecret),
                    signature = CryptoJS.enc.Base64.stringify(signatureSha),
                    authorizationOrigin = `api_key="${APIKey}", algorithm="${algorithm}", headers="${headers}", signature="${signature}"`,
                    authorization = btoa(authorizationOrigin);
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
                this.webWorker = new Worker(new URL('./transcode.worker.js', import.meta.url));
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

    setResultText({ resultText, resultTextTemp } = {}) {
        this.onTextChange && this.onTextChange(resultTextTemp || resultText || '');
        resultText !== undefined && (this.resultText = resultText);
        resultTextTemp !== undefined && (this.resultTextTemp = resultTextTemp);
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

    connectWebSocket() {
        return this.getWebSocketUrl().then(url => {
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
            iatWS.onopen = e => {
                this.setStatus('ing');
                setTimeout(() => {
                    this.webSocketSend();
                }, 500);
            };
            iatWS.onmessage = e => {
                this.webSocketRes(e.data);
            };
            iatWS.onerror = e => {
                this.recorderStop();
            };
            iatWS.onclose = e => {
                this.recorderStop();
            };
        })
    }

    webSocketSend() {
        if (this.webSocket.readyState !== 1) return false;
        const audioData = this.audioData.splice(0, 1280);
        const params = {
            "header": {
                "app_id": this.APPID,
                "status": 0
            },
            "parameter": {
                "iat": {
                    "domain": "slm",
                    "language": this.language,
                    "accent": this.accent,
                    "eos": 6000,
                    "vinfo": 1,
                    "dwa": "wpgs",
                    "result": {
                        "encoding": "utf8",
                        "compress": "raw",
                        "format": "json"
                    }
                }
            },
            "payload": {
                "audio": {
                    "encoding": "raw",
                    "sample_rate": 16000,
                    "channels": 1,
                    "bit_depth": 16,
                    "seq": 1,
                    "status": 0,
                    "audio": this.toBase64(audioData)
                }
            }
        };
        this.webSocket.send(JSON.stringify(params));
        this.handlerInterval = setInterval(() => {
            if (this.audioData.length === 0) {
                if (this.status === 'end') {
                    this.webSocket.send(JSON.stringify({
                        "header": {
                            "app_id": this.APPID,
                            "status": 2
                        },
                        "payload": {
                            "audio": {
                                "encoding": "raw",
                                "sample_rate": 16000,
                                "channels": 1,
                                "bit_depth": 16,
                                "seq": 591,
                                "status": 2,
                                "audio": ""
                            }
                        }
                    }));
                    this.audioData = [];
                    clearInterval(this.handlerInterval);
                }
                return false;
            };
            this.webSocket.send(JSON.stringify({
                "header": {
                    "app_id": this.APPID,
                    "status": 1
                },
                "payload": {
                    "audio": {
                        "encoding": "raw",
                        "sample_rate": 16000,
                        "channels": 1,
                        "bit_depth": 16,
                        "seq": 2,
                        "status": 1,
                        "audio": this.toBase64(this.audioData.splice(0, 1280))
                    }
                }
            }));
        }, 40);
    }

    webSocketRes(resultData) {
        let jsonData = JSON.parse(resultData);
        let str = ""
        if (jsonData.payload && jsonData.payload.result) {
            let data = jsonData.payload.result;
            let text = atob(data.text);
            let ws = JSON.parse(text);
            if (ws.ls === false) {
                for (let index = 0; index < ws.ws.length; index++) {
                    const element = ws.ws[index];
                    str += element.cw[0].w
                }
            }
            if (str !== "") {
                this.setResultText({
                    resultText: str
                });
            }
        }
        if (jsonData.header.code === 0 && jsonData.header.status === 2) {
            this.webSocket.close();
        }
        if (jsonData.header.code !== 0) {
            this.webSocket.close();
        }
    }

    recorderInit() {
        try {
            this.audioContext = this.audioContext ? this.audioContext : new (window.AudioContext || window.webkitAudioContext)();
            this.audioContext.resume();
            if (!this.audioContext) {
                this.onError('浏览器不支持webAudioApi相关接口');
                return false;
            }
        } catch (e) {
            this.onError('浏览器不支持webAudioApi相关接口');
            return false;
        };

        let getMediaSuccess = _ => {
            this.scriptProcessor = this.audioContext.createScriptProcessor(0, 1, 1);
            this.scriptProcessor.onaudioprocess = e => {
                if (this.status === 'ing') {
                    try {
                        this.webWorker.postMessage(e.inputBuffer.getChannelData(0));
                    } catch (error) { }
                }
            }
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

        navigator.getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia;
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            navigator.mediaDevices.getUserMedia({
                audio: true
            }).then(stream => {
                this.streamRef = stream;
                getMediaSuccess();
            }).catch(e => {
                getMediaFail(e);
            })
        } else if (navigator.getUserMedia) {
            navigator.getUserMedia({
                audio: true
            }, (stream) => {
                this.streamRef = stream;
                getMediaSuccess();
            }, (e) => {
                getMediaFail(e);
            })
        } else {
            if (navigator.userAgent.toLowerCase().match(/chrome/) && location.origin.indexOf('https://') < 0) {
                console.error('需要在localhost或127.0.0.1或https下才能获取录音权限！');
            } else {
                this.onError('未识别到录音设备!');
            }
            this.audioContext && this.audioContext.close();
            return false;
        };
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
        if (!(/Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent))) {
            this.audioContext && this.audioContext.suspend();
        }
        this.setStatus('end');
        try {
            this.streamRef.getTracks().forEach(track => track.stop());
        } catch (error) {
            console.error('暂停失败!');
        }
    }

    start() {
        this.recorderStart();
        this.setResultText({ resultText: '', resultTextTemp: '' });
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
        };
    }, [opts]);

    return voiceRef.current;
};

export default XfVoiceDictation;
