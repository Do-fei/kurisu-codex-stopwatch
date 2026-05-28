# V0 Bring-Up Checklist

## 1. Mac Bridge

From the Apple Watch bridge directory:

```sh
cd /Users/dawei/Documents/灵光一闪/codex-apple-watch
CODEX_WATCH_SHOW_NETWORK_HINTS=1 npm run bridge
```

Use the printed LAN IP to set `BRIDGE_BASE_URL` in the firmware config:

```cpp
#define BRIDGE_BASE_URL "http://<mac-lan-ip>:17842"
```

Quick bridge check:

```sh
curl http://<mac-lan-ip>:17842/codex-stopwatch/state
```

Expected: JSON with `type: "stopwatch-state"` and a `state` such as `idle`.

## 2. Firmware Config

Copy the private config:

```sh
cd /Users/dawei/Documents/灵光一闪/codex-stopwatch
cp firmware/include/config.example.h firmware/src/config_local.h
```

Edit `firmware/src/config_local.h` locally:

```cpp
#define WIFI_SSID "..."
#define WIFI_PASSWORD "..."
#define BRIDGE_BASE_URL "http://<mac-lan-ip>:17842"
#define PAIRING_TOKEN ""
```

Do not commit or paste Wi-Fi credentials.

## 3. Build

The V0 firmware reuses the Codex `hatchling` pet asset. Regenerate it only if
the source spritesheet changes:

```sh
cd /Users/dawei/Documents/灵光一闪/codex-stopwatch
./scripts/generate-hatchling-assets.py
```

```sh
cd /Users/dawei/Documents/灵光一闪/codex-stopwatch/firmware
../scripts/build.sh
```

If `pio` is missing, install PlatformIO first.

## 4. Upload

Connect StopWatch by USB-C.

```sh
cd /Users/dawei/Documents/灵光一闪/codex-stopwatch
./scripts/upload.sh
```

If upload cannot enter download mode:

1. Keep USB-C connected.
2. Hold the red PWR/Boot key until the green light appears.
3. Retry `./scripts/upload.sh`.

## 5. Serial Log

```sh
cd /Users/dawei/Documents/灵光一闪/codex-stopwatch
./scripts/monitor.sh
```

Expected logs:

- Wi-Fi connection attempt.
- `GET http://.../codex-stopwatch/state`.
- No repeating JSON parse errors.

## 6. V0 Acceptance

- Boot screen shows the Kurisu-inspired pet.
- Header changes to `Mac linked` once bridge is reachable.
- Status page reflects `IDLE`, `THINKING`, `RUNNING`, `WAIT OK`, `DONE`, or `ERROR`.
- Usage pages show quota, today tokens, and today cost values, or `--` if unavailable.
- A/B buttons switch page or usage metric.
- Tap changes expression.
- Swipe changes page.
- Long press refreshes.
- Completion, approval/input-needed, and failure events vibrate with different pulse patterns.
