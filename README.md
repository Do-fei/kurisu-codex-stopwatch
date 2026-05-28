# Kurisu Codex StopWatch Companion

> A tiny M5Stack StopWatch companion for Codex: pet presence, live status, CodexBar-aligned usage, haptics, and push-to-talk.
>
> 一个基于 M5Stack StopWatch 的 Codex 小伴侣：显示红莉栖风格待机形象、实时状态、与 CodexBar 对齐的用量、震动提醒和按住说话。

## What It Is / 项目简介

Kurisu Codex StopWatch Companion turns an M5Stack StopWatch into a small local-first hardware companion for Codex on macOS. The device connects to a Mac bridge over Wi-Fi, then shows what Codex is doing: idle, thinking, running commands, waiting for confirmation, replying, or failing.

Kurisu Codex StopWatch Companion 会把 M5Stack StopWatch 变成一个本地优先的 Codex 硬件伴侣。设备通过 Wi-Fi 连接 Mac bridge，然后在小屏幕上显示 Codex 当前状态：空闲、思考中、执行命令、等待确认、收到回复或出错。

The project is designed as a non-Apple-Watch companion path: no Xcode signing loop, no watchOS background limits, and direct firmware-level control over display, touch, buttons, microphone, and vibration.

这个方向相当于「非 Apple Watch 版」Codex 伴侣：不依赖 Apple 签名，不受 watchOS 后台限制，可以直接控制固件里的屏幕、触摸、实体键、麦克风和震动。

## Features / 功能

- Companion status screen with a Kurisu-inspired idle pet and subtle mood changes.
- Codex state sync from the Mac bridge: idle, thinking, command running, waiting, replied, and error.
- Usage pages aligned with CodexBar:
  - 5-hour quota
  - weekly quota
  - today token total
  - today cost
- Events page for recent user input and Codex reply summaries.
- Push-to-talk voice input from the StopWatch microphone.
- Haptic feedback for completion, send success, errors, approvals, and refresh actions.
- Setup portal for Wi-Fi, Mac bridge URL, device name, brightness, and optional pairing token.
- Light safety for the setup portal: manual close plus automatic timeout.

- 红莉栖风格待机形象和轻量表情变化。
- 从 Mac bridge 同步 Codex 状态：空闲、思考、执行命令、等待确认、已回复、出错。
- 与 CodexBar 对齐的用量页：
  - 5 小时额度
  - 每周额度
  - 今日 token 总数
  - 今日 cost
- Events 页面显示最近输入和 Codex 回复摘要。
- 通过 StopWatch 麦克风按住说话。
- 完成、发送成功、错误、需要批准、刷新时震动提醒。
- 配置网页支持 Wi-Fi、Mac bridge URL、设备名、亮度和可选 pairing token。
- 配置入口支持手动关闭和超时自动关闭。

## Architecture / 架构

```text
M5Stack StopWatch
  | Wi-Fi HTTP
  v
Mac bridge: bridge/codex-watch-bridge.mjs
  | local Codex app-server + Codex session logs + CodexBar cache
  v
Codex desktop state, replies, quota, today tokens, today cost
```

```text
M5Stack StopWatch
  | Wi-Fi HTTP
  v
Mac bridge: bridge/codex-watch-bridge.mjs
  | 本地 Codex app-server + Codex 会话日志 + CodexBar 缓存
  v
Codex 桌面状态、回复、额度、今日 token、今日 cost
```

The bridge intentionally stays local. The StopWatch polls:

```text
GET http://<mac-lan-ip>:17842/codex-stopwatch/state
```

Voice upload and confirmed transcript sending use:

```text
POST /codex-stopwatch/voice
POST /codex-stopwatch/transcript
```

## Repository Layout / 目录结构

```text
bridge/                         Mac bridge for Codex and StopWatch
tests/server/                   Node bridge tests
firmware/                       PlatformIO firmware for M5Stack StopWatch
firmware/include/config.example.h
firmware/src/main.cpp
scripts/                        Build, upload, monitor, and asset helpers
docs/                           Bring-up notes and CodexBar parity notes
```

## Requirements / 环境要求

- macOS with Codex desktop installed.
- Node.js 20+ for the Mac bridge.
- Python 3 + PlatformIO for firmware builds.
- M5Stack StopWatch hardware.
- A 2.4 GHz Wi-Fi network reachable by both the Mac and the StopWatch.
- Optional: CodexBar, for matching today tokens and today cost.

- 已安装 Codex 桌面端的 macOS。
- Node.js 20+，用于 Mac bridge。
- Python 3 + PlatformIO，用于固件编译。
- M5Stack StopWatch 硬件。
- Mac 和 StopWatch 都能访问的 2.4 GHz Wi-Fi。
- 可选：CodexBar，用于对齐今日 token 和今日 cost。

## Quick Start / 快速开始

### 1. Run the Mac bridge / 启动 Mac bridge

```sh
npm run bridge
```

For LAN debugging, print network hints:

```sh
CODEX_WATCH_SHOW_NETWORK_HINTS=1 CODEX_WATCH_HOST=:: npm run bridge
```

Verify the StopWatch state endpoint:

```sh
curl -sS http://<mac-lan-ip>:17842/codex-stopwatch/state
```

### 2. Configure firmware defaults / 配置固件默认值

Copy the example config locally:

```sh
cp firmware/include/config.example.h firmware/src/config_local.h
```

Edit `firmware/src/config_local.h` with your local Wi-Fi and bridge URL. This file is ignored by git and should never be committed.

编辑 `firmware/src/config_local.h`，写入本地 Wi-Fi 和 bridge URL。这个文件已被 git 忽略，不应该提交。

### 3. Build firmware / 编译固件

```sh
./scripts/build.sh
```

### 4. Upload firmware / 刷入固件

Connect the StopWatch over USB-C, then run:

```sh
./scripts/upload.sh --upload-port /dev/cu.usbmodem101
```

The serial port may differ on your machine.

### 5. Monitor device logs / 查看设备日志

```sh
./scripts/monitor.sh --port /dev/cu.usbmodem101
```

## Device Interaction / 设备交互

- Swipe left/right: switch pages.
- Tap the pet: switch expression and show a short affection moment.
- Long press screen: refresh bridge state.
- Yellow/A button: previous page, or open/close setup on System page.
- Blue/B button: next page, or hold to record voice and release to stop.

- 左右滑动：切换页面。
- 点击小人：切换表情并触发短暂亲昵反馈。
- 长按屏幕：刷新 bridge 状态。
- 黄色/A 键：上一页；在 System 页长按可打开/关闭配置入口。
- 蓝色/B 键：下一页；长按开始录音，松开停止。

## Safety Notes / 安全说明

- Keep `firmware/src/config_local.h` private.
- Do not commit Wi-Fi passwords, bridge tokens, or local IP-specific secrets.
- The setup portal is intended for trusted local networks.
- If `CODEX_WATCH_PAIRING_TOKEN` is set on the bridge, configure the same token on the device.

- 请保管好 `firmware/src/config_local.h`。
- 不要提交 Wi-Fi 密码、bridge token 或其他本地敏感配置。
- 配置网页面向可信本地网络使用。
- 如果 bridge 设置了 `CODEX_WATCH_PAIRING_TOKEN`，设备端也需要配置同一个 token。

## Validation / 验证

Bridge checks:

```sh
npm run check
```

Firmware build:

```sh
./scripts/build.sh
```

Hardware smoke test:

```sh
./scripts/upload.sh --upload-port /dev/cu.usbmodem101
./scripts/monitor.sh --port /dev/cu.usbmodem101
```

Expected behavior:

- Status page shows the companion and Mac connection state.
- Usage pages show quota, today tokens, and today cost.
- Events page shows recent user/Codex activity.
- System page shows Wi-Fi, bridge, power, brightness, IP, and setup state.
- Push-to-talk records on B hold and sends after confirmation.

预期表现：

- Status 页显示小人和 Mac 连接状态。
- Usage 页显示额度、今日 token 和今日 cost。
- Events 页显示最近用户/Codex 活动。
- System 页显示 Wi-Fi、bridge、电量、亮度、IP 和配置状态。
- 长按 B 键录音，确认后发送。

## Attribution / 说明

This is an independent local hardware companion experiment for Codex. It is not affiliated with OpenAI, M5Stack, CodexBar, or Steins;Gate. The companion personality and visual direction are fan-inspired and should be replaced with your own licensed assets if you publish a derivative product.

这是一个独立的本地硬件伴侣实验项目，与 OpenAI、M5Stack、CodexBar 或《Steins;Gate》没有官方关联。小人设定和视觉方向属于粉丝向灵感；如果要发布衍生产品，请替换为你拥有授权的素材。

## License / 许可证

No open-source license has been selected yet. Add a license before accepting external contributions.

目前尚未选择开源许可证。接受外部贡献前请先补充许可证。
