# DSH Pet Voice V2

[![Cross-platform build](https://github.com/pwang7874-crypto/deepseekharness-/actions/workflows/cross-platform.yml/badge.svg)](https://github.com/pwang7874-crypto/deepseekharness-/actions/workflows/cross-platform.yml)

系统级桌宠伴侣：DeepSeek Harness（DSH）插件负责产生会话/任务事件，Tauri 桌面应用负责透明置顶桌宠、语音、动画和原生通知。

## V2 功能

- 用户可设置桌宠名字、人物介绍、说话语气，以及情侣、主仆、朋友、宠物等关系。
- JPG/PNG/GIF 会被自动分层为带呼吸、点头、说话和情绪动作的 2.5D 角色，不再只是覆盖在默认角色上的贴图。
- VRM/GLB 文件使用 Three.js 与 three-vrm 渲染为真正的三维角色；已有 Live2D 模型仍可通过 `model3.json` 地址使用。
- 点击麦克风即可录音，本机 Whisper 将语音转成文字并直接发送到当前 DSH 任务；模型首次使用时下载并缓存，之后可离线识别。
- 桌宠支持 `−` / `＋` 一键缩放，也可拖动窗口边缘调整大小。
- 支持音色参考样本；当前系统 TTS 可按情绪调整语速、音高与音量。
- 回答时展示文字气泡，并根据开心、思考、担心、兴奋等情绪改变动作。
- DSH 任务完成或失败时显示气泡并发送系统通知。
- GitHub Actions 分别在 Windows x64、Linux x64、macOS ARM64 与 macOS Intel 上构建安装包。
- 桌面安装包内置 DSH 插件，首次启动自动查找 DSH、安装插件并启动 `web` profile；无需复制仓库链接或运行终端命令。

## 普通用户：一键安装

1. 打开 GitHub 仓库的 **Releases** 页面，下载自己系统的安装包（Windows `.exe`、Linux `.AppImage`/`.deb`、macOS `.app`）。
2. 安装并打开 **DSH Pet Voice**。程序会自动找到本机 `dsh`、安装随程序携带的 `dsh-pet-voice-v2` 插件并连接事件桥。
3. 如果 DSH 已经在运行，首次安装后按桌宠提示重启一次 DSH；如果没有自动找到，点气泡上方的“选择 DSH 并自动安装”，只需选择 `dsh`、`dsh.exe` 或 `dsh.cmd`。

直接把 GitHub 仓库网址发给 DeepSeek Harness 不会安装桌面窗口：仓库是源码，真正给普通用户使用的是 Releases 中的系统安装包。桌宠是透明置顶的独立桌面窗口，不会显示在 DSH 聊天消息区域里。

## 开发结构

- `packages/dsh-pet-plugin`：可安装的 DSH host 插件，提供本地事件流、任务状态与提醒工具。
- `apps/pet-companion`：Tauri 2 桌面窗口，连接插件的事件流，驱动情绪、动画和通知。

## 开发者启动

1. 安装 Node.js 24、pnpm 11、Rust stable，以及当前系统所需的 [Tauri 2 前置依赖](https://v2.tauri.app/start/prerequisites/)。
2. 运行 `pnpm install && pnpm build`。
3. 运行 `pnpm --dir apps/pet-companion prepare:plugin`，它会构建插件并生成桌面端内置资源。
4. 运行 `pnpm dev:companion`。伴侣会优先识别 macOS/Windows 上的 DSH Desktop，并把插件安装到它当前启用的配置；找不到桌面版时才回退到 PATH 中的 `dsh` CLI。需要调试 CLI 模式的手动安装时，可执行 `dsh plugin --profile web add ./apps/pet-companion/src-tauri/resources/dsh-pet-plugin.tgz`。

安装插件后，桌面端连接 `http://127.0.0.1:3080/dsh-pet/events`。它使用 token 验证，拒绝非本机和未验证请求。

## 构建桌面安装包

```bash
pnpm --filter @dsh-pet/companion tauri build
```

Pull Request 会执行类型检查、行为测试和多平台构建验证。macOS 构建目前未进行 Apple 公证，首次打开可能需要在“隐私与安全性”中手动允许；正式发布时应配置开发者签名和公证凭据。

只有在确认体验后手动推送 `v*` 标签，才会创建 GitHub Release 并上传四个平台安装包；普通分支提交不会发布。当前安装包尚未进行 Windows 代码签名和 Apple 公证，因此系统可能显示发布者未知或安全提醒。

## 开源组件与许可

- `zhuiyueya/dsh-voice`（MIT）：DSH 语音插件的双端包结构参考。
- `guansss/pixi-live2d-display`（MIT）：可选 Live2D 渲染器；用户须自行提供具有使用权的 Cubism Core 与角色资产。
- `pixiv/three-vrm`（MIT）与 `mrdoob/three.js`（MIT）：VRM/GLB 三维角色渲染。
- `huggingface/transformers.js`（Apache-2.0）与 OpenAI Whisper 模型：WebView 内本机语音识别。

本项目不携带任何第三方角色模型或 Cubism Core。
