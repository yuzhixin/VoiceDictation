import CryptoJS from 'crypto-js';

export default class IatRecorder {
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
        this.onError = opts.onError || Function();

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
        this.textSegments = [];
    };

    // 获取webSocket请求地址鉴权
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
    };

    // 操作初始化
    init() {
        const self = this;
        try {
            if (!self.APPID || !self.APIKey || !self.APISecret) {
                this.onError('请正确配置【迅飞语音听写 WebAPI】服务接口认证信息！');
                return;
            }
            const workerScript = `
            (() => {
                const transAudioData = {
                    to16kHz(audioData) {
                        var data = new Float32Array(audioData);
                        var fitCount = Math.round(data.length * (16000 / 44100));
                        var newData = new Float32Array(fitCount);
                        var springFactor = (data.length - 1) / (fitCount - 1);
                        newData[0] = data[0];
                        for (let i = 1; i < fitCount - 1; i++) {
                            var tmp = i * springFactor;
                            var before = Math.floor(tmp).toFixed();
                            var after = Math.ceil(tmp).toFixed();
                            var atPoint = tmp - before;
                            newData[i] = data[before] + (data[after] - data[before]) * atPoint;
                        }
                        newData[fitCount - 1] = data[data.length - 1];
                        return newData;
                    },
                    to16BitPCM(input) {
                        var dataLength = input.length * (16 / 8);
                        var dataBuffer = new ArrayBuffer(dataLength);
                        var dataView = new DataView(dataBuffer);
                        var offset = 0;
                        for (var i = 0; i < input.length; i++, offset += 2) {
                            var s = Math.max(-1, Math.min(1, input[i]));
                            dataView.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
                        }
                        return dataView;
                    },
                    transcode(audioData) {
                        let output = transAudioData.to16kHz(audioData);
                        output = transAudioData.to16BitPCM(output);
                        output = Array.from(new Uint8Array(output.buffer));
                        self.postMessage(output);
                    }
                };
                self.onmessage = function (e) {
                    transAudioData.transcode(e.data);
                };
            })()
            `;
            const blob = new Blob([workerScript], { type: 'application/javascript' });
            const url = URL.createObjectURL(blob);
            self.webWorker = new Worker(url);
            self.webWorker.onmessage = function (event) {
                self.audioData.push(...event.data);
            };
        } catch (error) {
            this.onError('对不起：请在服务器环境下运行！');
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
                this.onError('浏览器不支持WebSocket');
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
                this.setStatus('end');
                try {
                    this.streamRef && this.streamRef.getTracks().forEach(track => track.stop());
                } catch (e) {
                    console.error('Error stopping media stream:', e);
                }
                clearInterval(this.handlerInterval); // 确保 interval 被清除
                console.log('WebSocket 连接已关闭');
            };
        })
    };

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

    // 初始化浏览器录音
    recorderInit() {
        // 创建音频环境
        try {
            this.audioContext = this.audioContext ? this.audioContext : new (window.AudioContext || window.webkitAudioContext)();
            this.audioContext.resume();
            if (!this.audioContext) {
                this.onError('浏览器不支持webAudioApi相关接口');
                return false;
            }
        } catch (e) {
            if (!this.audioContext) {
                this.onError('浏览器不支持webAudioApi相关接口');
                return false;
            }
        };
        // 获取浏览器录音权限成功时回调
        let getMediaSuccess = () => {
            if (!this.audioContext) {
                return;
            }
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
            this.onError('对不起：录音权限获取失败');
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
                this.onError('对不起：未识别到录音设备');
            }
            this.audioContext && this.audioContext.close();
            return false;
        };
    };
    // 向webSocket发送数据(音频二进制数据经过Base64处理)
    webSocketSend() {
        if (!this.webSocket || this.webSocket.readyState !== 1) return false;
        // 音频数据
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
        // 发送数据
        this.webSocket.send(JSON.stringify(params));
        this.handlerInterval = setInterval(() => {
            // websocket断开或状态不是ing时，直接清除定时器
            if (!this.webSocket || this.webSocket.readyState !== 1 || this.status !== 'ing') {
                clearInterval(this.handlerInterval);
                this.handlerInterval = null;
                return;
            };
            // 发送中间帧
            this.webSocket.send(
                JSON.stringify({
                    header: { app_id: this.APPID, status: 1 },
                    // ... payload for intermediate frame
                    payload: {
                        audio: {
                            // ...
                            status: 1,
                            audio: this.toBase64(this.audioData.splice(0, 1280)),
                        },
                    },
                })
            );
        }, 40);
    };

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

    // 识别结束 webSocket返回数据
    webSocketRes(resultData) {
        const jsonData = JSON.parse(resultData);
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
            this.webSocket.close();
        }
    };
    // 启动录音
    recorderStart() {
        this.setStatus("ing")
        if (!this.audioContext) {
            this.recorderInit();
        } else {
            this.audioContext.resume();
            this.connectWebSocket();
        }
    };
    // 停止录音
    // 停止录音
    recorderStop() {
        console.log(this.status)
        // 如果状态已经是 end 或 closed，则不重复执行
        // if (this.status !== 'ing') {
        //     return;
        // }

        console.log("主动停止录音...");
        this.setStatus('end');

        // 1. 立即清除 interval，防止再发送中间帧
        clearInterval(this.handlerInterval);
        this.handlerInterval = null;

        // 2. 立即发送结束帧 (status: 2)
        console.log(1111111111111111111111111)
        this.webSocket.send(JSON.stringify({
            header: { app_id: this.APPID, status: 2 },
            payload: {
                audio: {
                    encoding: 'raw',
                    sample_rate: 16000,
                    channels: 1,
                    bit_depth: 16,
                    seq: 999, // use a final sequence number
                    status: 2,
                    audio: "",
                },
            },
        }));
        console.log(222222222222222222)

        // 3. 暂停音频上下文和清理数据
        if (!(/Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent))) {
            this.audioContext && this.audioContext.suspend();
        }
        this.audioData = [];
    };
    // 开始
    start() {
        this.setResultText({ resultText: '', resultTextTemp: '' });
        this.recorderStart();
    };
    // 停止
    stop() {
        this.recorderStop();
    };
}

