declare module 'xf-voice' {
  interface XfVoiceOptions {
    APPID: string;
    APIKey: string;
    APIsecret: string;
    onTextChange?: (text: string) => void;
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
