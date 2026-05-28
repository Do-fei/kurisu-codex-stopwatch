#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIRMWARE_DIR="$ROOT/firmware"

export PATH="$HOME/Library/Python/3.9/bin:$PATH"
export PLATFORMIO_CORE_DIR="$FIRMWARE_DIR/.platformio-core"
export PLATFORMIO_SETTING_ENABLE_TELEMETRY=no

cd "$FIRMWARE_DIR"
python3 -m platformio device monitor -b 115200 "$@"

