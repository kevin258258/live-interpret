# 桌面浏览器与音频采集依据

核对日期：2026-10-15。本文记录官方能力与候选方案，没有桌面实测结果。

## 浏览器入口

Chrome 的 `chrome.tabCapture` 可以取得标签页媒体流，需要用户主动触发扩展操作及 `tabCapture` 权限。取得流后，原标签页声音会停止直接播放，扩展必须将流接回音频输出，否则会破坏“保留主播原声”的要求。Chrome 116 起，service worker 取得的流 ID 可以交给 offscreen document 使用；录音只放在 popup 中会随 popup 关闭而停止。[Chrome API 文档](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)、[官方后台采集示例](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture)

**候选实现：** 在 macOS / Linux 的 Chrome 上，以扩展启动标签页音频采集，保持原声输出，将音频交给识别翻译链路，并在观看网页展示字幕。这里仅确认 Chrome 的 API 依据；目标网站的全屏布局、跨域播放器、导航和内容变化仍需逐项测试。

普通网页 `getDisplayMedia({ audio: true, video: true })` 不能保证拿到声音。W3C 规范允许浏览器只返回视频轨；音频来源也可以与画面来源不同，取决于浏览器提供的选择。实现必须检查实际音轨及数据，不能看到屏幕共享成功就判定音频采集成功。[W3C Screen Capture 规范](https://www.w3.org/TR/screen-capture/)

Safari 支持基于 Web 技术的扩展及与原生 App 通信，但 Apple 明确要求检查扩展 API 的浏览器兼容性。可打包为 Safari 扩展不等于 Chrome 的采集 API 能原样使用。[Apple Safari 扩展文档](https://developer.apple.com/documentation/safariservices/safari-web-extensions)、[Apple Safari 扩展概览](https://developer.apple.com/safari/extensions/)

**尚未确定：** 用户桌面首选浏览器。Safari、Firefox 及其他浏览器仍属于待验证范围，不能通过 Chrome 测试替代。

## macOS 原生入口

Apple 的 macOS ScreenCaptureKit 示例提供 `SCStreamConfiguration.capturesAudio`、排除当前进程音频，以及注册 `.audio` 输出的方式。它是需要浏览器之外音频来源时的候选路径；权限交互和具体应用兼容性需要在 macOS 真机验证。[Apple macOS 采集示例](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)

**候选实现：** 原生伴随 App 负责采集；浏览器扩展或桌面字幕界面负责展示。是否需要这个入口，应由目标浏览器覆盖和真机验证结果决定。

## Linux 原生入口

PipeWire 官方 `pw-cat` 文档提供录音模式及 `--target` 节点选择，可用于录音能力验证。选择到输出监视源、仅获取目标 App 声音，以及在用户桌面音频配置中保持稳定，均需检查实际音频图及会话策略；不能从存在录音命令推断所有桌面环境已经兼容。[PipeWire pw-cat 文档](https://docs.pipewire.org/page_man_pw-cat_1.html)

**候选实现：** 浏览器入口先验证标签页声音；需要覆盖其他 App 时再引入 PipeWire 原生适配。Linux 的全屏字幕层、Wayland / X11 差异仍需单独验证。

## 下一步验证

1. 用 YouTube / Twitch 浏览器直播验证目标标签页音频、原声输出、扩展关闭后的行为和停止采集。
2. 检查全屏切换、标签页导航、网络恢复、蓝牙输出切换后音频及字幕状态。
3. 为每个实际支持的 OS / 浏览器组合记录版本和结果；未测试项标记为未验证。

项目优先顺序见 [项目说明](../README.md)。桌面入口的可行性不能替代 iPad 官方 App 场景验证。
