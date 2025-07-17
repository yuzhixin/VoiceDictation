export interface IatRecorderOptions {
  APPID: string;
  APIKey: string;
  APISecret: string;
  url?: string;
  host?: string;
  onTextChange?: (text: string) => void;
  onError?: (text: string) => void;
  onWillStatusChange?: (oldStatus: string, newStatus: string) => void;
  language?: string;
  accent?: string;
}

export default class IatRecorder {
  constructor(options: IatRecorderOptions);

  APPID: string;
  APISecret: string;
  APIKey: string;
  url: string;
  host: string;
  onTextChange: (text: string) => void;
  onWillStatusChange: (oldStatus: string, newStatus: string) => void;
  status: string;
  language: string;
  accent: string;
  streamRef: MediaStream[];
  audioData: any[];
  resultText: string;
  resultTextTemp: string;

  getWebSocketUrl(): Promise<string>;
  init(): void;
  setStatus(status: string): void;
  setResultText(params: { resultText?: string; resultTextTemp?: string }): void;
  setParams(params: { language?: string; accent?: string }): void;
  toBase64(buffer: any): string;
  connectWebSocket(): Promise<void | boolean>;
  recorderInit(): void;
  webSocketSend(): void;
  webSocketRes(resultData: string): void;
  recorderStart(): void;
  recorderStop(): void;
  start(): void;
  stop(): void;
}
