declare module 'xf-voice' {
  interface XfVoiceOptions {
    APPID: string;
    APIKey: string;
    APISecret: string;
    onTextChange?: (text: string) => void;
    /**
     * 错误回调函数(注意: 会被自动包装在setTimeout中调用以防止React重渲染)
     * @param error 错误信息
     */
    onError?: (error: string) => void;
    onWillStatusChange?: (oldStatus: string, newStatus: string) => void;
    language?: string;
    accent?: string;
    url?: string;
    host?: string;
  }

  class XfVoiceDictation {
    constructor(options: XfVoiceOptions);
    start(): void;
    stop(): void;
    setStatus(status: string): void;
    setResultText(params: { resultText?: string, resultTextTemp?: string }): void;
    setParams(params: { language?: string, accent?: string }): void;
  }

  export default XfVoiceDictation;
}
