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
        this.onError = opts.onError || Function();

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

    // 其他方法保持不变...
    // [保留原有方法实现，但移除分号和函数表达式]
    // ...

    start() {
        this.recorderStart();
        this.setResultText({ resultText: '', resultTextTemp: '' });
    }

    stop() {
        this.recorderStop();
    }
}

export default XfVoiceDictation;
