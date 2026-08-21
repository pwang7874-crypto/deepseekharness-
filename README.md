# DSH Pet Voice V2

[![Cross-platform build](https://github.com/pwang7874-crypto/deepseekharness-/actions/workflows/cross-platform.yml/badge.svg)](https://github.com/pwang7874-crypto/deepseekharness-/actions/workflows/cross-platform.yml)

系统级桌宠伴侣：DeepSeek Harness（DSH）插件负责产生会话/任务事件，Tauri 桌面应用负责透明置顶桌宠、语音、动画和原生通知。

## V2 功能

- 用户可设置桌宠名字、人物介绍、说话语气，以及情侣、主仆、朋友、宠物等关系。
- 支持上传 PNG/GIF 皮肤、Live2D 模型地址和音色参考样本；当前系统 TTS 可按情绪调整语速、音高与音量。
- 回答时展示文字气泡，并根据开心、思考、担心、兴奋等情绪改变动作。
- DSH 任务完成或失败时显示气泡并发送系统通知。
- GitHub Actions 分别在 Windows x64、Linux x64、macOS ARM64 与 macOS Intel 上构建安装包。

## 开发结构

- `packages/dsh-pet-plugin`：可安装的 DSH host 插件，提供本地事件流、任务状态与提醒工具。
- `apps/pet-companion`：Tauri 2 桌面窗口，连接插件的事件流，驱动情绪、动画和通知。

## 启动

1. 安装 Node.js 24、pnpm 11、Rust stable，以及当前系统所需的 [Tauri 2 前置依赖](https://v2.tauri.app/start/prerequisites/)。
2. 运行 `pnpm install && pnpm build`。
3. 在 DSH profile 中安装 `packages/dsh-pet-plugin`，并把 `pet-bridge.token` 改为一个随机值。
4. 在桌宠设置中填写同一个 token，然后运行 `pnpm dev:companion`。

安装插件后，桌面端连接 `http://127.0.0.1:3080/dsh-pet/events`。它使用 token 验证，拒绝非本机和未验证请求。

## 构建桌面安装包

```bash
pnpm --filter @dsh-pet/companion tauri build
```

每次推送到 `main` 都会执行类型检查与行为测试，然后生成各平台的 GitHub Actions artifacts。macOS 构建目前未进行 Apple 公证，首次打开可能需要在“隐私与安全性”中手动允许；正式发布时应配置开发者签名和公证凭据。

## 开源组件与许可

- `zhuiyueya/dsh-voice`（MIT）：DSH 语音插件的双端包结构参考。
- `guansss/pixi-live2d-display`（MIT）：可选 Live2D 渲染器；用户须自行提供具有使用权的 Cubism Core 与角色资产。
- `ricky0123/vad`：可选浏览器端语音活动检测。

本项目不携带任何第三方角色模型或 Cubism Core。
