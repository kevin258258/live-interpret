# iPad / iPhone 原生直播字幕可行性

核验日期：2026-10-15。目标设备是用户的最新款 iPad Air，先支持最新稳定系统；主要来源为 YouTube、Twitch 官方 App，英语／日语语音转中文字幕。未推测具体 Air 型号。当前工作环境为 Linux，尚未进行 Apple SDK 编译、真机采集或平台账号验证。

## 当前建议

以 **iOS / iPadOS 27+ 的 ScreenCaptureKit** 为第一条采集验证路线。Apple 已将其扩展到 iOS / iPadOS，并说明屏幕流传输不再需要 ReplayKit Broadcast Extension。字幕显示另做验证：优先比较 iPad 的并排窗口／Slide Over 与“直播视频原生 PiP + 本工具前台字幕”；“官方 App 全屏 + 任意位置透明字幕条”仍为待验证体验，不能由采集 API 的存在推出。[ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)、[iOS 官方采集示例](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-on-ios)

上述是架构建议，**不代表已证实 YouTube 或 Twitch 音频可采，也不代表文字 PiP 已获审核认可**。

## 已确认的系统与 API 边界

| 事项 | 官方证据与适用范围 |
| --- | --- |
| 最新稳定主线 | Apple 在 2026-09-14 宣布 iOS / iPadOS 27 开始发布；9 月 9 日已开放使用新 SDK 的 App Store 提交。不能因为个别示例页还显示 Beta 提示，就把整个 27 系统当成未发布。见 [正式发布公告](https://www.apple.com/newsroom/2026/09/major-updates-for-apples-software-platforms-are-now-available/)、[开发者提交公告](https://developer.apple.com/news/?id=k1mtkt1k)。 |
| ScreenCaptureKit iOS / iPadOS 起点 | 官方文档 JSON 的 `metadata.platforms` 标注 iOS、iPadOS 均自 `27.0` 引入；iOS 示例也要求 27 或更新版本。见 [框架文档](https://developer.apple.com/documentation/screencapturekit)、[官方版本元数据](https://developer.apple.com/tutorials/data/documentation/screencapturekit.json)。 |
| 替换旧广播入口 | 框架说明 ScreenCaptureKit 替换 ReplayKit 的屏幕流传输／镜像能力，无需广播扩展；`RPSystemBroadcastPickerView` 自 iOS / iPadOS 12.0 引入、27.0 弃用，迁移提示指向 `SCContentSharingPicker`。见 [新框架说明](https://developer.apple.com/documentation/screencapturekit)、[旧入口文档](https://developer.apple.com/documentation/replaykit/rpsystembroadcastpickerview)、[旧入口版本元数据](https://developer.apple.com/tutorials/data/documentation/replaykit/rpsystembroadcastpickerview.json)。 |
| 旧音频处理器状态 | `RPBroadcastSampleHandler` 自 iOS / iPadOS 10.0 引入，27.0 弃用，元数据提示为 `No longer supported`。保留为旧系统兼容性研究资料，不能以其作为 27+ 产品主线。见 [处理器文档](https://developer.apple.com/documentation/replaykit/rpbroadcastsamplehandler)、[版本元数据](https://developer.apple.com/tutorials/data/documentation/replaykit/rpbroadcastsamplehandler.json)。 |

资料冲突处理：本次读取的 iOS 示例页仍附有 Beta Software 提示，而系统正式发布公告与 API 的 27.0 版本元数据已存在。采用“系统已发布、API 文档明确 27+，具体示例与可用 SDK 仍需编译核验”的表述；不能据此承诺用户当前设备上的完整采集行为。[iOS 示例](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-on-ios)、[正式发布公告](https://www.apple.com/newsroom/2026/09/major-updates-for-apples-software-platforms-are-now-available/)

## 采集路线：明确区分全屏与本 App

Apple 的 iOS 示例区分两种入口：`SCContentSharingPicker.present()` 让用户选择整个显示屏采集；`presentForCurrentApplication()` 将可选范围限制为当前 App 自己的窗口与图层。跨 App 研究应采用前者，不能拿本 App 的采集结果证明官方直播 App 可用。[iOS 官方示例：Present the content-sharing picker](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-on-ios#Present-the-content-sharing-picker)

候选实现为：显式用户授权 → 系统选择器 → 返回的 `SCContentFilter` → `SCStream` → 音频样本 → ASR／翻译 → 字幕。框架要求屏幕录制权限，并说明配置 `NSScreenCaptureUsageDescription`；按系统选择器建立会话，不设计静默开启采集的流程。[ScreenCaptureKit 概述](https://developer.apple.com/documentation/screencapturekit)

音频需要显式设置 `SCStreamConfiguration.capturesAudio = true`，默认不采集；接入 `SCStreamOutputType.audio` 获取音频 `CMSampleBuffer`。这两个 API 在 iOS / iPadOS 的版本元数据均为 27.0。麦克风样本属于另一输出类型，产品先关闭麦克风，以数字音频为验证目标；不用扬声器回录来冒充跨 App 采集成功。[capturesAudio](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturesaudio)、[audio 输出](https://developer.apple.com/documentation/screencapturekit/scstreamoutputtype/audio)

**仍需真机验证：** 全显示屏模式下，YouTube / Twitch 正在播放的直播是否提供连续、非静音的数字音频；画面与音频是否受内容类型、播放模式、路由、账号或 App 更新影响。上述通用 API 文档没有为这两个具体 App 作兼容性保证。

旧 ReplayKit 路线中，`RPSystemBroadcastPickerView` 是用户选择广播提供方的入口，`RPBroadcastSampleHandler.processSampleBuffer` 处理广播收到的视频／音频，`audioApp` 表示应用来源音频，区别于 `audioMic`。这些定义本身不足以保证任意目标 App 的直播音频；也不能与仅记录自己 App 的 `RPScreenRecorder` 混为一谈。旧系统的跨 App 覆盖与后台生命周期需单独重测，本期不优先实现。[系统广播入口](https://developer.apple.com/documentation/replaykit/rpsystembroadcastpickerview)、[广播处理器](https://developer.apple.com/documentation/replaykit/rpbroadcastsamplehandler)、[audioApp](https://developer.apple.com/documentation/replaykit/rpsamplebuffertype/audioapp)、[RPScreenRecorder](https://developer.apple.com/documentation/replaykit/rpscreenrecorder)

## 受保护内容：不能用黑屏推导音频结果

ReplayKit 概述仍写有与 `AVPlayer` 内容不兼容的说明。这属于 ReplayKit 文档边界，不能扩写为“新 ScreenCaptureKit 必定不能采集所有 AVPlayer 音频”，也不能忽略该提示后宣称旧广播路径一定支持任意播放器。[ReplayKit 概述](https://developer.apple.com/documentation/replaykit)

Apple 的屏幕捕获说明区分 FairPlay 视频和音频：受保护视频会被遮黑，但音频不因此自动排除；媒体 App 还可检测采集并自行暂停播放。因此“黑屏”“无音频样本”“有样本但静音”“来源 App 停播”必须分开记录，不能一律叫 DRM 不支持。该说明也不等于承诺任何具体内容可采。[UIScreen.isCaptured 讨论](https://developer.apple.com/documentation/uikit/uiscreen/iscaptured)、[Apple QA1970](https://developer.apple.com/library/archive/qa/qa1970/_index.html)

产品遇到来源停止／禁止采集时显示明确状态，不设计绕过保护的实现。

## 字幕怎么留在直播旁边

| 布局 | 已确认能力 | 尚未确认 |
| --- | --- | --- |
| 直播 App 与字幕 App 并排 | Apple 文档支持 iPad 的多窗口、窗口缩放与并排显示；26.2 起还提供可保持在其他窗口上方的 Slide Over。见 [iPad 多任务说明](https://support.apple.com/en-us/125309)。 | YouTube / Twitch 当前版本在该布局下的直播连续播放、可用最小窗口、字幕阅读舒适度；是否能满足用户躺床观看的大画面需求。 |
| 直播 App 的真实视频 PiP + 本工具前台字幕 | PiP 的官方用途是让视频在使用其他 App 时继续播放。见 [AVPictureInPictureController](https://developer.apple.com/documentation/avkit/avpictureinpicturecontroller)。 | 每个目标 App、每种内容是否允许 PiP；进入 PiP 后能否同步取得来源音频。该布局的字幕在本工具中，视频小窗由来源 App 提供。 |
| 官方直播 App 全屏 + 本工具透明文字浮层 | 普通 `UIWindowScene` 管理的是本 App 的窗口；这个 API 的定义不能当作跨 App 文字叠层能力。见 [UIWindowScene](https://developer.apple.com/documentation/uikit/uiwindowscene)。 | 本次没有找到把任意 `UIView` 固定覆盖到其他 App 全屏视频的通用公开 API 依据。保留为待研究目标，不写成已经支持，也不扩写为任何系统管理的浮窗都不可能。 |
| 把字幕生成视频帧放进自己的 PiP | Apple 支持 `AVSampleBufferDisplayLayer` 作为 PiP 内容源，存在自定义视频渲染能力。见 [自定义播放器 PiP](https://developer.apple.com/documentation/avkit/adopting-picture-in-picture-in-a-custom-player)、[WWDC21 AVKit](https://developer.apple.com/videos/play/wwdc2021/10290/)。 | 字幕专用 PiP 的用途、后台行为、布局与审核适用性。不能因为文字能画进视频帧，就称其为获 Apple 认可的任意透明字幕浮层；也不借用视频通话模式伪装通话。 |

YouTube 当前官方 iOS 帮助写明可在离开 App 后继续 PiP；非音乐内容可用，音乐内容（包括用户翻唱等）需要 Premium。当前 Premium 帮助明确非音乐长视频及 Shorts 面向所有用户开放 PiP；不要沿用 2022 年发布时的美国非会员限制作为当前规则。VTuber 歌回可能触及音乐分类，实际账号、内容、设置和直播场景均需测试。[YouTube iOS PiP 帮助](https://support.google.com/youtube/answer/7552722?co=GENIE.Platform%3DiOS&hl=en)、[当前 Premium 权益说明](https://support.google.com/youtube/answer/6308116?co=GENIE.Platform%3DiOS&hl=en)

Twitch 的当前 iOS 跨 App PiP 和音频采集条件，本次未找到足以保证该场景的官方说明，列为真机待验；桌面网页的 Popout / Mini Player 说明不能替代 iPad 系统 PiP 证明。

iPhone 单独验证来源视频 PiP + 前台字幕及后续专用 PiP 研究；不能把上述 iPad 多窗口文档当作 iPhone 具备相同窗口能力的依据。

## 后台与网络

Apple iOS 示例为全显示屏采集声明 `UIBackgroundModes` 的 `screen-capture`，说明其用于非前台时保持流；其 `audio` 模式用于麦克风采样。这给采集会话提供了文档依据，但不等于 ASR／翻译处理和网络连接已经通过长时间真机验证，也不应照搬麦克风示例来开启产品不需要的录音。[官方示例：Configure the sample code project](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-on-ios#Configure-the-sample-code-project)

普通 App 进入后台可能被挂起；`beginBackgroundTask` 只为完成任务申请额外时间。后台 `URLSession` 的文件传输可在挂起时由系统继续执行，不能直接当成实时语音 WebSocket 常驻保证。ASR／翻译链路必须随着真实采集会话测量断线、恢复、积压与停止状态。[后台执行时间](https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time)、[后台网络传输](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background)

App Review 2.5.4 要求后台服务用于其声明用途，2.5.1 要求 API 按预期用途使用，2.5.14 要求记录用户活动时有明确同意与提示。因此字幕专用 PiP 的审核适用性仍待证明，不能把“运行成功”当作“可公开发布”的证据。[App Review Guidelines 2.5](https://developer.apple.com/app-store/review/guidelines/#software-requirements)

## 真机实验与判定门槛

先做最小采集／字幕实验，以下全部标记为 **未执行**。设备记录实际型号、系统版本和 build；App 记录版本、账号地区、订阅状态、直播 URL、内容类型及网络路径。用有明确授权的测试语音或可重复的自有直播先排除音源问题，再测实际 VTuber 直播。

诊断至少记录：选定捕获范围、音频样本数量与时间戳、格式、音量能量、来源播放是否继续、生命周期事件、采集错误、网络连接状态、首条／最终字幕时间；不默认保存用户画面或原始音频。下列时长是实验方案，**不是声称的系统后台限额**。

| 实验 | 操作 | 可证伪的判定 |
| --- | --- | --- |
| 数字音源基线 | 关闭麦克风，用耳机播放 60 秒已知英文／日文片段，随后暂停来源。 | 播放时能收到匹配语音的非静音样本；暂停后不能继续产生旧语音。耳机条件排除扬声器回录。 |
| 跨 App / 全屏 | 从系统全显示屏选择器启动，进入 YouTube；重复 Twitch，切横竖屏与全屏各 5 分钟。 | 本工具不在前台时仍有正确音频；明确区分采集、来源停播与字幕不可见。 |
| 来源 PiP | 每个 App 从播放切至视频 PiP，再进入字幕 App；测试恢复全屏与关闭 PiP。 | 视频、数字音频与中文字幕同时持续；关闭／停止时字幕状态能对应变化。 |
| 并排 / Slide Over | 最新 Air 真机运行来源窗口和字幕窗口，触摸来源、改变大小、移出／恢复字幕。 | 实际可操作且直播继续，字幕不遮挡关键画面；记录真实最小窗口与阅读反馈。 |
| 蓝牙与输出路由 | 内置扬声器、蓝牙耳机；中途连接／断开耳机并切回扬声器。 | 每条路由都有数字音频；格式变化后恢复，原声正常且不意外启用麦克风。 |
| 暂停 / 切源 / 广告 | 暂停恢复、切换频道、遇到实际广告或缓冲。 | 不把旧片段字幕接到新直播；静音与停播显示对应状态，不无限积压。 |
| 锁屏 / 打断 | 锁屏再解锁；切到另一 App；触发音频中断后恢复。 | 记录哪些阶段来源继续或停止、流是否终止；停止后清理网络，恢复有明确操作与状态。 |
| 受保护 / 无音频 | 自有无声内容及合法可访问的受保护内容，观察黑屏、静音、拒绝与停播。 | 各原因可区分；失败明确提示，不靠麦克风自动兜底掩盖结果。 |
| 断网与长播 | 断开／恢复网络；最终选定布局连续运行 30 分钟并观察耗电和发热。 | 不无限缓存或重复字幕；重连后恢复当前直播，采集／字幕端到端链路可持续。 |
| 主动停止 / 会话结束 | 用系统停止入口或工具内停止，尝试来源结束与服务错误。 | 停止后样本处理与上传结束，界面明确提示；重新开始需遵循系统授权流程。 |

第一阶段通过条件：至少在用户实际 iPad Air 上证明 YouTube 与 Twitch 各自有一条“原声继续 + 数字音频可采 + 中文字幕可同时读”的完整布局。若只能在部分内容或付费账号下成功，按测试条件列出覆盖范围；不能把一种来源／布局的成功泛化为全部官方 App 全屏适配。
