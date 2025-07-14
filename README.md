# xf-voice

讯飞语音听写(流式版)WebAPI的React/Node.js SDK

## 安装

```bash
npm install xf-voice
```

## 使用示例

### Node.js 环境

```javascript
const XfVoiceDictation = require('xf-voice');

const recorder = new XfVoiceDictation({
  APPID: '你的APPID',
  APIKey: '你的APIKey',
  APISecret: '你的APISecret',
  onTextChange: (text) => {
    console.log('识别结果:', text);
  }
});

// 开始录音
recorder.start();

// 停止录音
setTimeout(() => {
  recorder.stop();
}, 5000);
```

### React 环境

```jsx
import React, { useState, useEffect } from 'react';
import XfVoiceDictation from 'xf-voice';

function VoiceRecorder() {
  const [text, setText] = useState('');
  
  useEffect(() => {
    const recorder = new XfVoiceDictation({
      APPID: '你的APPID',
      APIKey: '你的APIKey',
      APISecret: '你的APISecret',
      onTextChange: (result) => {
        setText(result);
      }
    });

    return () => {
      recorder.stop();
    };
  }, []);

  return (
    <div>
      <button onClick={() => recorder.start()}>开始录音</button>
      <button onClick={() => recorder.stop()}>停止录音</button>
      <div>识别结果: {text}</div>
    </div>
  );
}

export default VoiceRecorder;
```

## API

### 构造函数

`new XfVoiceDictation(options)`

参数:
- `options.APPID`: 必填，讯飞开放平台APPID
- `options.APIKey`: 必填，讯飞开放平台APIKey
- `options.APISecret`: 必填，讯飞开放平台APISecret
- `options.onTextChange`: 识别结果回调函数
- `options.onWillStatusChange`: 状态变更回调函数
- `options.language`: 语言，默认'zh_cn'
- `options.accent`: 方言，默认'mandarin'

### 方法

- `start()`: 开始录音
- `stop()`: 停止录音
- `setParams({language, accent})`: 设置识别参数

## 注意事项

1. React项目需要v16.8+版本(支持Hooks)
2. 需要在服务端环境下运行
3. 需要有效的讯飞开放平台账号和API权限
4. 浏览器需要支持Web Audio API和WebSocket
5. 在Chrome浏览器中需要在https或localhost环境下才能获取麦克风权限
6. 使用React时，建议在组件卸载时调用stop()方法
7. Worker文件需要正确放置在public/js/目录下
