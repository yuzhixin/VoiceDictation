; (function (window, voice) {
    "use strict";
    if (typeof define === 'function' && define.amd) {
        define(voice);
    } else if (typeof exports === 'object') {
        module.exports = voice();
    } else {
        window.XfVoiceDictation = voice();
    };
}(typeof window !== "undefined" ? window : this, () => {
    "use strict";
    return class IatRecorder {
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

            // 方言/语种
            this.status = 'null'
            this.language = opts.language || 'zh_cn'
            this.accent = opts.accent || 'mandarin';

            // 流媒体
            this.streamRef = [];
            // 记录音频数据
            this.audioData = [];
            // 记录听写结果
            this.resultText = '';
            // wpgs下的听写结果需要中间状态辅助记录
            this.resultTextTemp = '';
            // 音频数据多线程
            this.init();
        };

        // 获取webSocket请求地址鉴权
        getWebSocketUrl() {
            return new Promise((resolve, reject) => {
                const { url, host, APISecret, APIKey } = this;
                // 请求地址根据语种不同变化
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
                    let date = new Date().toGMTString(),
                        algorithm = 'hmac-sha256',
                        headers = 'host date request-line',
                        signatureOrigin = `host: ${host}\ndate: ${date}\nGET /v1 HTTP/1.1`,
                        signatureSha = CryptoJS.HmacSHA256(signatureOrigin, APISecret),
                        signature = CryptoJS.enc.Base64.stringify(signatureSha),
                        authorizationOrigin = `api_key="${APIKey}", algorithm="${algorithm}", headers="${headers}", signature="${signature}"`,
                        authorization = btoa(authorizationOrigin);
                    resolve(`${url}?authorization=${authorization}&date=${date}&host=${host}`);
                };
            });
        };

        // 操作初始化
        init() {
            const self = this;
            try {
                if (!self.APPID || !self.APIKey || !self.APISecret) {
                    alert('请正确配置【迅飞语音听写（流式版）WebAPI】服务接口认证信息！');
                } else {
                    self.webWorker = new Worker('./js/transcode.worker.js');
                    self.webWorker.onmessage = function (event) {
                        self.audioData.push(...event.data);
                    };
                }
            } catch (error) {
                alert('对不起：请在服务器环境下运行！');
                console.error('请在服务器如：WAMP、XAMPP、Phpstudy、http-server、WebServer等环境中运行！', error);
            };
        };
        // 修改录音听写状态
        setStatus(status) {
            this.onWillStatusChange && this.status !== status && this.onWillStatusChange(this.status, status);
            this.status = status;
        };
        // 设置识别结果内容
        setResultText({ resultText, resultTextTemp } = {}) {
            this.onTextChange && this.onTextChange(resultTextTemp || resultText || '');
            resultText !== undefined && (this.resultText = resultText);
            resultTextTemp !== undefined && (this.resultTextTemp = resultTextTemp);
        };
        // 修改听写参数
        setParams({ language, accent } = {}) {
            language && (this.language = language)
            accent && (this.accent = accent)
        };
        // 对处理后的音频数据进行base64编码，
        toBase64(buffer) {
            let binary = '';
            let bytes = new Uint8Array(buffer);
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            return window.btoa(binary);
        };
        // 连接WebSocket
        connectWebSocket() {
            return this.getWebSocketUrl().then(url => {
                let iatWS;
                if ('WebSocket' in window) {
                    iatWS = new WebSocket(url);
                } else if ('MozWebSocket' in window) {
                    iatWS = new MozWebSocket(url);
                } else {
                    alert('浏览器不支持WebSocket!');
                    return false;
                }
                this.webSocket = iatWS;
                this.setStatus('init');
                iatWS.onopen = e => {
                    this.setStatus('ing');
                    // 重新开始录音
                    setTimeout(() => {
                        this.webSocketSend();
                    }, 500);
                };
                iatWS.onmessage = e => {
                    this.webSocketRes(e.data);
                };
                iatWS.onerror = e => {
                    this.recorderStop(e);
                };
                iatWS.onclose = e => {
                    this.recorderStop(e);
                };
            })
        };
        // 初始化浏览器录音
        recorderInit() {
            // 创建音频环境
            try {
                this.audioContext = this.audioContext ? this.audioContext : new (window.AudioContext || window.webkitAudioContext)();
                this.audioContext.resume();
                if (!this.audioContext) {
                    alert('浏览器不支持webAudioApi相关接口');
                    return false;
                }
            } catch (e) {
                if (!this.audioContext) {
                    alert('浏览器不支持webAudioApi相关接口');
                    return false;
                }
            };
            // 获取浏览器录音权限成功时回调
            let getMediaSuccess = _ => {
                // 创建一个用于通过JavaScript直接处理音频
                this.scriptProcessor = this.audioContext.createScriptProcessor(0, 1, 1);
                this.scriptProcessor.onaudioprocess = e => {
                    if (this.status === 'ing') {
                        // 多线程音频数据处理
                        try {
                            this.webWorker.postMessage(e.inputBuffer.getChannelData(0));
                        } catch (error) { }
                    }
                }
                // 创建一个新的MediaStreamAudioSourceNode 对象，使来自MediaStream的音频可以被播放和操作
                this.mediaSource = this.audioContext.createMediaStreamSource(this.streamRef);
                this.mediaSource.connect(this.scriptProcessor);
                this.scriptProcessor.connect(this.audioContext.destination);
                this.connectWebSocket();
            };
            // 获取浏览器录音权限失败时回调
            let getMediaFail = (e) => {
                alert('对不起：录音权限获取失败!');
                this.audioContext && this.audioContext.close();
                this.audioContext = undefined;
                // 关闭websocket
                if (this.webSocket && this.webSocket.readyState === 1) {
                    this.webSocket.close();
                }
            };
            navigator.getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia;
            // 获取浏览器录音权限
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
                }, function (e) {
                    getMediaFail(e);
                })
            } else {
                if (navigator.userAgent.toLowerCase().match(/chrome/) && location.origin.indexOf('https://') < 0) {
                    console.error('获取浏览器录音功能，因安全性问题，需要在localhost 或 127.0.0.1 或 https 下才能获取权限！');
                } else {
                    alert('对不起：未识别到录音设备!');
                }
                this.audioContext && this.audioContext.close();
                return false;
            };
        };
        // 向webSocket发送数据(音频二进制数据经过Base64处理)
        webSocketSend() {
            if (this.webSocket.readyState !== 1) return false;
            // 音频数据
            const audioData = this.audioData.splice(0, 1280);
            const params = {
                "header": {
                    "app_id": this.APPID,
                    "status": 0
                },
                "parameter": {
                    "iat": {
                        "domain": "slm",
                        "language": "zh_cn",
                        "accent": "mandarin",
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
            // 发送数据
            this.webSocket.send(JSON.stringify(params));
            this.handlerInterval = setInterval(() => {
                // websocket未连接
                // if (this.webSocket.readyState !== 1) {
                //     this.audioData = [];
                //     clearInterval(this.handlerInterval);
                //     return false;
                // };
                if (this.audioData.length === 0) {
                    if (this.status === 'end') {
                        this.webSocket.send(
                            JSON.stringify({
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
                            })
                        );
                        this.audioData = [];
                        clearInterval(this.handlerInterval);
                    }
                    return false;
                };
                // 中间帧
                this.webSocket.send(
                    JSON.stringify({
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
                    })
                );
            }, 40);
        };

        base64ToUtf8(base64Str) {
            const binaryStr = atob(base64Str);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) {
                bytes[i] = binaryStr.charCodeAt(i);
            }
            const utf8Decoder = new TextDecoder("utf-8");
            return utf8Decoder.decode(bytes);
        }

        // 识别结束 webSocket返回数据
        webSocketRes(resultData) {
            let jsonData = JSON.parse(resultData);
            let str = ""
            if (jsonData.payload && jsonData.payload.result) {
                let data = jsonData.payload.result;
                let ws = JSON.parse(this.base64ToUtf8(data.text));
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
        };
        // 启动录音
        recorderStart() {
            if (!this.audioContext) {
                this.recorderInit();
            } else {
                this.audioContext.resume();
                this.connectWebSocket();
            }
        };
        // 停止录音
        recorderStop() {
            if (!(/Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgen))) {
                // safari下suspend后再次resume录音内容将是空白，设置safari下不做suspend
                this.audioContext && this.audioContext.suspend();
            }
            this.setStatus('end');
            try {
                // this.streamRef.getTracks().map(track => track.stop()) || his.streamRef.getAudioTracks()[0].stop();
            } catch (error) {
                console.error('暂停失败!');
            }
        };
        // 开始
        start() {
            this.recorderStart();
            this.setResultText({ resultText: '', resultTextTemp: '' });
        };
        // 停止
        stop() {
            this.recorderStop();
        };
    };
}));
