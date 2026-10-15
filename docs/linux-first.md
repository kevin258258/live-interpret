# Linux 首版实现与验证

2026-10-15，用户将当前优先级调整为先实现 Linux，并选择填写自己的 API 地址和密钥。桌面浏览器尚未指定，首版以 Chrome / Chromium 为基线；Firefox 不在本版覆盖范围。

## 代码结构

```text
server/             本机 HTTP 服务、私有配置、识别翻译适配、字幕会话及有界队列
web/                字幕工作台、配置、样式、历史与术语表
extension/          Manifest V3 扩展、后台音频采集、播放器字幕层
extension/lib/      音频重采样、能量分段、WAV 编码、SSE 读取
tests/              音频边界、取消、积压处理、HTTP 与接口契约测试
scripts/            语法检查及浏览器交互检查
```

运行时只有 Node.js 标准库和浏览器 API，无需安装后端框架或下载模型。

## 观看路径

1. 用户保存独立的识别与翻译兼容接口，配对浏览器扩展。
2. 用户在 YouTube / Twitch 播放页主动开始。
3. 扩展使用 tabCapture 与 offscreen document 获取标签页声音，同时在原采样率播放主播原声。
4. 只有识别分支转换为 16kHz，按能量与暂停间隔分段，编码成单声道 WAV。
5. 本机服务调用转写接口，再携带术语及最近两段上下文请求中文翻译。
6. 字幕经本机 SSE 推送给工作台与扩展；扩展用独立 Shadow DOM 在播放器区域显示，全屏时重挂到全屏容器。

此处“流式”指连续采集与字幕推送；模型调用是分段文件转写和非流式文本翻译，不声称已实现模型级实时识别。

## 体验选择

- 默认平衡模式：最长约 6 秒一段，语音后安静约 650ms 断句。更快 / 更完整模式分别取约 3.5 / 9 秒最长片段。
- 短促响声不会单独上传，静音只保留短暂前置缓存，不无限增长。
- 一个片段处理时，只保留最新一个等待片段；慢服务导致丢弃时明确提示，不假装字幕仍跟得上。
- 不无条件重试旧音频，以免重复计费或把延迟越拉越长；连续三次处理失败停止当前会话。
- 切换到其他直播地址时结束旧会话，需要用户在新直播上重新开始，以免串台。
- 字幕自动消隐；隐藏字幕与停止采集是不同操作。`Alt + Shift + S` 只切换显示，需要停止时使用明确的停止按钮。

## 配置与请求边界

监听 loopback，配置 API 和 SSE 使用随机配对码鉴权。阻止无关网页 Origin 和无关 Host；凭据不出现在配置响应、字幕事件或直播页 DOM 中。上游错误显示经过归类的状态，不直接转发可能含密钥的错误体。

配对码每次进程启动更新，保存在本项目 `.local/connection.json`。扩展启动后主动获取数字音频；不自动切换为麦克风。

当前只实现 OpenAI 兼容的文件转写 / Chat Completions 两条协议。不兼容的服务需要新增适配器，不能仅靠填写网页 URL 接入。

## 已验证与未验证

自动检查覆盖：静音与长音频分段、WAV 格式、采样率转换、晚到结果取消、切换会话隔离、积压淘汰、失去心跳停止、连续 API 错误停止、真实本机 HTTP 请求、multipart 转写格式、翻译上下文、SSE UTF-8 消息边界及密钥不返回前端。

浏览器检查使用本机模拟 API、合成音频与播放器 DOM。它验证配置流程、示例、样式、术语、字幕历史导出、窄屏布局、全屏字幕重挂、文本注入防护和停止清理，不等于真实直播 tabCapture 或识别模型质量测试。

另已通过 `npm run test:extension`：隔离 Chromium 153 加载原扩展，使用真实工具栏动作取得 activeTab 授权；在被拦截的 YouTube 测试页中播放合成 Web Audio 音源，真实 offscreen / tabCapture 获取到非静音 48kHz 音频，并转换为 WAV 到达识别处理阶段。模拟识别翻译结果返回到原扩展字幕层，实时样式更新及主动停止也已通过。该测试没有模拟 tabCapture API，没有打开真实直播或调用付费服务；无头浏览器的 popup 使用同一扩展文档发送控制消息。

运行该扩展检查需要支持 `Extensions.triggerAction` 的新 Chromium 和 Playwright。测试关闭自动化的默认静音参数，否则合成标签页音频会被测试浏览器静音。其结果验证采集机制，不证明实际 YouTube / Twitch 内容、播放器更新或用户账户的兼容性。

待实际观看测试：

- 在用户日常桌面浏览器中安装扩展，验证真实直播的工具栏开始 / 停止操作。
- YouTube / Twitch 当前播放器布局、广告、频道切换及至少 30 分钟观看。
- 真实 API 服务的语种覆盖、端到端延迟、费用及限流情况。
- 蓝牙耳机连接 / 断开后的原声输出和采集持续性。
- 大音量 BGM、歌回、多人说话时能量分段的误触发与识别质量。

不能从“工作台能显示示例”推出以上待测项已通过。也不把服务器接收音频后的处理耗时作为观众听到语音至看见中文字幕的完整延迟。

## 官方接口依据

- [Chrome tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)
- [Chrome 后台音频采集示例](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture)
- [Chrome offscreen document](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [OpenAI 转写接口格式](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)
- [OpenAI Chat Completions 格式](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
