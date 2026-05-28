#pragma once

// Copy this file to firmware/src/config_local.h and edit the values there.
// Keep config_local.h private; it is ignored by git.

#define WIFI_SSID ""
#define WIFI_PASSWORD ""
#define BRIDGE_BASE_URL "http://192.168.1.2:17842"
#define PAIRING_TOKEN ""
#define DEVICE_ID "kurisu-stopwatch-01"

// V5 setup portal fallback. If Wi-Fi cannot connect, StopWatch starts this
// access point and serves the setup page at http://192.168.4.1/.
#define SETUP_AP_SSID "Kurisu-Setup"
#define SETUP_AP_PASSWORD "kurisu2026"
