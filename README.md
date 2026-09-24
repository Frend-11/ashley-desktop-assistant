# Ashley

![Ashley desktop assistant preview](docs/preview.png)

由 [@陆叁昧](https://www.douyin.com/user/601786286)（抖音号 `601786286`）在抖音上构建并演示，
构建过程、踩过的坑以及反复尝试才成功的部分，都按当时发生的样子记录在案。

Ashley 是一款面向 macOS、Linux 和 Windows 的桌面语音助手。她的透明 Three.js 头像悬浮在桌面上方，
支持语音交互、组装与碎裂特效、旋转、手势、天气查询，以及实验性的音乐控制。

## 唤醒词可用性与限制

- **开箱即用：** 仅 **"Hey Jarvis"**，使用随附的 openWakeWord 社区模型。该触发词
  属于上游模型，与本项目名称无关。
- **实验性的 Ashley 唤醒：** 录入你的声音后，**"Ashley"** 可以通过本地个人声学模板
  匹配唤醒应用。这条路径只验证说话人身份，没有独立的词级模型，因此周围有电视、
  音乐或其他说话人时更容易误唤醒。
- **稳定的自定义唤醒词：** 用 `scripts/wake-word-training` 训练词级 ONNX 模型，
  放到 `assets/wake-word/models/`，再用 `JARVIS_EXTRA_WAKE_MODELS` 启用。
  本仓库不包含维护者的个人模型、阈值、样本或录音。

仓库随附一个经过优化的、开放许可的科幻头盔模型，以及程序化生成的音效。
仓库不包含 API 凭据、个人唤醒词模型、声音训练样本或本地录音。

## 社区版

这是社区版。它是一个完整可用的助手，但并非作者本机运行的全部内容。这里把边界写清楚，
免得有人克隆了项目才发现差异。

**包含且完整可用**

- 随附的 "Hey Jarvis" 唤醒词、本地个人声纹录入，以及加载自己训练的词级模型的配置路径
- 通过豆包或 OpenAI 进行实时语音对话，支持打断（barge-in）
- 透明 3D 头像：组装、碎裂、旋转和手势
- 天气查询，使用设备定位
- 地图搜索与路线（macOS 用 Apple 地图，Linux 和 Windows 用高德地图）
- 启动和退出应用，包括本地化的中文应用名
- 桌面切换（macOS Spaces；Linux X11 工作区；Windows 虚拟桌面）
- 实验性的音乐控制：酷狗和网易云音乐，Linux 上的 MPRIS 媒体控制，
  Windows 上驱动网易云音乐、酷狗音乐或汽水音乐的语音搜歌，以及全局媒体键
- 任务委派给本机 OpenClaw 智能体（检测到 OpenClaw 才启用，见下文）

**刻意不包含**

- **Codex 桥。** 在作者的私有构建中，助手可以把任务交给一个编码智能体，
  由它编写并运行代码，还能通过 macOS 辅助功能 API 驱动其他应用。这条路径会在主机上
  执行任意命令，需要精心受限的环境才安全。把它默认开启后分发给陌生人，
  是本项目不愿承担的风险，因此它不属于公开构建。
  公开版提供的是更保守的替代：任务委派走你自己安装并配置的 OpenClaw，
  见「OpenClaw 任务委派」。
- **全息地图。** 它依赖另一个私有的应用程序。

上面列出的所有「包含」功能都不依赖这两者。本仓库中没有任何被阉割或残废的代码：
被省略的都是被干净移除的完整功能，而非被禁用的代码路径。

## 环境要求

- macOS 13 Ventura 或更高版本（Apple 芯片是主要测试目标），
  或带 GNOME 的 Ubuntu 24.04 或更高版本，或 Windows 10 或更高版本
- Node.js 22 或更高版本
- pnpm 10 或更高版本
- Xcode 命令行工具，用于原生定位辅助程序（仅 macOS）
- 可选：`wmctrl`，用于 X11 会话下的窗口监测、工作区切换和关闭应用（Wayland 下不使用）
- 可选：`ffmpeg`，仅在重新生成随附音效时需要

Windows 不需要安装额外工具：所有桌面控制都通过系统自带的 PowerShell 5.1
（`powershell.exe`）调用 Windows API 完成。

## API 凭据

把 `.env.example` 复制为 `.env`，然后只填写你打算使用的服务商。永远不要提交 `.env`。

- `OPENAI_API_KEY`：OpenAI Realtime 语音。参照
  [OpenAI 开发者快速入门](https://platform.openai.com/docs/quickstart/make-your-first-api-request)创建密钥。
- `JARVIS_OPENAI_BASE_URL`：可选的 Realtime 接口地址覆盖项，用于中转或兼容服务
  （默认 `https://api.openai.com`）。
- `DOUBAO_APP_ID`、`DOUBAO_API_KEY`、`DOUBAO_RESOURCE_ID`：可选的豆包语音服务商。
  参照 [豆包语音文档](https://www.volcengine.com/docs/6561/196768)创建应用并开通所需服务。
- `QWEATHER_API_HOST`、`QWEATHER_API_KEY`：可选的天气查询。参照
  [和风天气项目与凭据指南](https://dev.qweather.com/en/docs/configuration/project-and-key/)创建项目和凭据。
- `JARVIS_DEFAULT_CITY`：天气请求未指明城市时使用的城市。

## 安装与运行

```bash
cp .env.example .env
pnpm install
pnpm dev
```

首次启动时，macOS 可能请求麦克风、辅助功能、Apple Events 和定位权限。
只授予你所用功能需要的权限。Windows 上 Chromium 会在首次使用麦克风时弹出系统提示；
定位服务若处于关闭状态，天气会回退到 `JARVIS_DEFAULT_CITY`。

只构建、不启动 Electron：

```bash
pnpm build
```

创建未打包的 macOS 应用：

```bash
pnpm package:mac
```

`scripts/sign-macos.sh` 默认使用临时签名（ad-hoc）。要生成可分发的签名构建，
把 `JARVIS_CODESIGN_IDENTITY` 设置为你的证书名称。

创建未打包的 Linux 应用：

```bash
pnpm package:linux
```

产物位于 `release/linux-unpacked/`。

创建 Windows 安装包（可在 macOS/Linux 上交叉构建，未签名）：

```bash
pnpm package:win
```

产物位于 `release/Ashley Setup <版本>.exe`。该构建未做代码签名，
SmartScreen 可能提示「未知发布者」；分发给他人前请自行签名。

## Linux 支持

Linux 用原生对应物替换了每个 macOS 专用接口：

- 应用启动会把说出的中文名匹配到已安装的 `.desktop` 文件
  （GNOME 应用通过内置映射表匹配，因为它们的本地化名称来自 gettext，并不存储在文件里）。
- 地图搜索和路线使用高德地图（`ditu.amap.com`）而不是 Apple 地图。
- 设备定位使用基于 IP 的查询（ipwho.is），不可用时回退到 `JARVIS_DEFAULT_CITY`。
  注意：这会把本机公网 IP 发送给第三方；仅在天气或路线请求未指明城市时才会查询。
- 音乐控制通过 D-Bus 上的 MPRIS 进行，适用于任何正在运行的播放器
  （网易云音乐 Linux 客户端、Spotify、浏览器播放等等）。用语音搜索并播放歌曲仍仅限 macOS：
  MPRIS 无法启动任意歌曲的播放，酷狗也没有 Linux 客户端。
- 组装音效通过 PulseAudio/PipeWire（`paplay`）播放。

Wayland 是 Ubuntu 的默认会话，它刻意不暴露其他应用的窗口。在 Wayland 下窗口监测被禁用
（Ashley 保持头像可见，而不是在桌面繁忙时自动隐藏），切换工作区或关闭其他应用会
明确回答「当前会话不可用」。登录 Xorg 会话即可启用这三项功能；
其余功能在两种会话下表现一致。

Wayland 下有两处外观差异：任务栏驻留和焦点由合成器而不是应用决定，
所以头像可能出现在任务栏中并可被点击；托盘图标是 macOS 模板图标的白色变体，
以便在 GNOME 深色顶栏上保持可见。

## Windows 支持

Windows 用系统自带的 PowerShell 5.1 作为桥接，把每个 macOS 专用接口替换为对应的
Windows API（主进程保持一个常驻 `powershell.exe` 桥接进程，按 JSON 行协议收发命令）：

- 窗口监测通过 user32 `EnumWindows` 系列 API，过滤规则与 macOS 的 Swift 辅助程序一致
  （排除工具窗口、被 cloak 的窗口和任务栏等桌面外壳，窗口尺寸 ≥100×80 才算占用）。
- 打开应用索引开始菜单（`Get-StartApps`），中文名直接说即可；桌面应用经 `explorer.exe`
  启动快捷方式，商店应用经 `shell:AppsFolder` 启动。关闭应用解析快捷方式目标后用
  `taskkill` 发送 `WM_CLOSE`（优雅退出，不强制结束），商店应用请手动关闭。
- 切换虚拟桌面用 `SendInput` 模拟 Win+Ctrl+←/→；媒体控制（播放/暂停、上一首、下一首）
  发送全局媒体键，作用于当前拥有系统媒体会话的播放器，因此不能指定具体软件。
- 设备定位使用 WinRT `Geolocator`（城市级精度），被拒绝或不可用时回退到基于 IP 的查询
  （ipwho.is），再不行回退 `JARVIS_DEFAULT_CITY`。
- 组装音效经 .NET `SoundPlayer` 播放；托盘图标是琥珀色变体，深浅任务栏均可见。
- 语音搜歌（`play_music`）驱动本机已登录的网易云音乐、酷狗音乐或汽水音乐：
  焦点窗口 → 点击搜索框 → 剪贴板粘贴歌名 → 回车 → 点击第一个结果，然后用系统媒体
  会话（SMTC）读出正在播放的标题来确认，不谎报成功。界面点击位置是窗口内的相对
  坐标（`music-automation.ps1` 顶部的配置表），与 macOS 版一样需要在真机上校准：
  托盘菜单「音乐搜索调试」导出指定播放器的界面元素树（UIA）和窗口几何，据此把
  搜索框和第一行结果的坐标填进配置表。

已知限制：Electron 在 Windows 上不能真正把窗口固定到所有虚拟桌面；切换虚拟桌面后
头像只驻留在它所在的那个桌面。

## Ashley 唤醒词

维护者的 Ashley 和 Jarvis 词级唤醒模型（`ashley.onnx` 和 `jarvis.onnx`）不包含在本仓库中。
用 `scripts/wake-word-training` 下的工具在你本机为自己的声音训练模型；
不要发布由此得到的个人模型。

不用改 TypeScript 就能加载自己训练的模型：把 ONNX 文件放到
`assets/wake-word/models/`，然后在 `.env` 里设置一行：

```dotenv
JARVIS_EXTRA_WAKE_MODELS=ashley:ashley.onnx,jarvis:jarvis.onnx
```

随附的 `hey_jarvis` 模型始终启用；删除或注释掉这一行即恢复默认的单模型配置。

打开托盘菜单，选择**录入 Ashley 唤醒声纹…**来录制本地唤醒声纹。声纹由 Electron 存储在
仓库之外，不会作为项目资源上传。说「Ashley」（包括受支持的中文音译）即可唤出头像；
为兼容保留旧别名。没有 Ashley 词级 ONNX 模型时，这条录入声纹的个人路径是实验性的
说话人/声学匹配，而非真正的词汇识别。

## 生成的音效

所有随附音效都由数学波形在本地合成，不使用任何下载的音频样本。重新生成：

```bash
pnpm generate:sounds
```

这会在 `assets/sounds/` 下创建 `wake.wav`、约 2.6 秒的 `assembly.wav`，
以及十个约 2 秒的低频思考提示音。

## 重建头盔资源

发布版的 `assets/helmet/model.glb` 已优化到约 40,000 个三角面。如果你有合法获取的
源 GLB，仓库保留了与发布资源相同的 glTF-Transform 管线：

```bash
pnpm build:helmet:opensource -- source.glb assets/helmet/model.glb 40000
```

源模型没有纹理，因此管线和渲染器使用程序化 PBR 材质：黑色拉丝枪金属、
分层赛博粉与赛博青细节，以及平滑的青色自发光眼部处理。

## OpenClaw 任务委派

如果启动时检测到本机装有 [OpenClaw](https://openclaw.ai) CLI（`openclaw` 命令；
常见位置包括 `~/.npm-global/bin` 和 `/usr/local/bin`，也可用 `JARVIS_OPENCLAW_BIN`
指定完整路径），语音会话会多出一个任务委派工具：说「帮我写一个脚本」「帮我
完成某件事」，Ashley 会把任务交给 OpenClaw 的默认智能体执行，完成后播报结果。

- 任务通过 `openclaw agent` 命令在你的 OpenClaw 工作区里执行，可能运行任意
  命令——请先确认 OpenClaw 自身的执行审批设置。检测不到 OpenClaw 时该工具
  不注册，其余功能不受影响。
- 执行期间会话事件实时流式返回：工具调用、执行的命令、skill 调用和回复片段
  会逐条写入运行日志，不必等任务结束才能看到进展。
- 任务完成后，播报会附带执行过程摘要——执行了什么代码、用了哪些工具、
  调用了什么 skills。
- 连续的任务沿用同一个会话，可以用「继续」「改一下」跟进。
- 单个任务最长 10 分钟，超时会终止并播报失败（附已完成部分摘要）；执行期间
  头像保持思考动画，运行日志每 30 秒输出一次进度心跳。

## 实验性音乐控制

音乐控制是实验性的。部分操作依赖应用窗口坐标而非稳定的公开 API。
酷狗音乐或网易云音乐的更新可能移动控件并暂时破坏这些操作。

## 致谢

- 模型：[Sci-Fi Helmet - High Poly - Ngchipv](https://sketchfab.com/3d-models/sci-fi-helmet-high-poly-ngchipv-2f7218f88b94455cb69411e4069dc3b9)
- 作者：[HiepVu](https://sketchfab.com/ngchipv)
- 许可：[Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)
- 来源：[Sketchfab](https://sketchfab.com/)

Ashley 的改动：几何体从 240,984 个三角面减少到约 40,000 个；
无纹理的源材质替换为程序化 PBR 材质和青色自发光眼部着色。

## 许可证

项目源代码以 [MIT License](LICENSE) 发布。头盔模型按上述署名的 CC BY 4.0 提供。
