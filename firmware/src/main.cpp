#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <M5Unified.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_heap_caps.h>

#include "hatchling_assets.h"

#if __has_include("config_local.h")
#include "config_local.h"
#else
#include "config.example.h"
#endif

#ifndef SETUP_AP_SSID
#define SETUP_AP_SSID "Kurisu-Setup"
#endif

#ifndef SETUP_AP_PASSWORD
#define SETUP_AP_PASSWORD "kurisu2026"
#endif

namespace {

constexpr uint32_t kPollIntervalMs = 2000;
constexpr uint32_t kWiFiRetryIntervalMs = 5000;
constexpr uint32_t kStatusAnimationIntervalMs = 280;
constexpr uint32_t kTouchQuietAfterMs = 520;
constexpr uint32_t kBridgeStaleMs = 20000;
constexpr uint32_t kStartupConnectionGraceMs = 22000;
constexpr uint8_t kBridgeFailureThreshold = 3;
constexpr uint8_t kWiFiSetupFailureThreshold = 6;
constexpr uint32_t kConfigPortalAutoCloseMs = 10UL * 60UL * 1000UL;
constexpr uint32_t kConfigPortalSuppressAfterCloseMs = 30UL * 60UL * 1000UL;
constexpr uint32_t kHapticHardStopMs = 320;
constexpr uint32_t kPowerPolicyIntervalMs = 10000;
constexpr uint8_t kM5IOE1Address = 0x4F;
constexpr uint32_t kM5IOE1Freq = 100000;
constexpr uint16_t kMotorPwmHz = 2000;
constexpr uint32_t kVoiceSampleRate = 16000;
constexpr uint32_t kVoiceMinMs = 500;
constexpr uint32_t kVoiceMaxMs = 8000;
constexpr uint32_t kVoiceConfirmHintMs = 4000;
constexpr uint32_t kVoiceHoldStartMs = 260;
constexpr size_t kVoiceChunkSamples = 320;
constexpr size_t kVoiceMaxSamples = (kVoiceSampleRate * kVoiceMaxMs) / 1000;

constexpr uint16_t kBg = 0xFFFF;
constexpr uint16_t kPanel = 0xF7BE;
constexpr uint16_t kPanelLine = 0xDEFB;
constexpr uint16_t kTrack = 0xE71C;
constexpr uint16_t kHalo = 0xF7DD;
constexpr uint16_t kText = 0x18E3;
constexpr uint16_t kDim = 0x7BEF;
constexpr uint16_t kAccent = 0xB127;
constexpr uint16_t kAffection = 0xE9D1;
constexpr uint16_t kSpark = 0xF6D5;
constexpr uint16_t kWarn = 0xE580;
constexpr uint16_t kError = 0xD1C9;
constexpr uint16_t kOk = 0x3D8E;

enum class Page {
  Status,
  Usage,
  Events,
  System
};

constexpr uint8_t kPageCount = 4;

struct UsageSnapshot {
  int32_t sessionTokens = -1;
  int32_t lastTurnTokens = -1;
  int32_t todayTokens = -1;
  float todayCostUSD = -1;
  int32_t todayTurns = 0;
  int32_t contextWindow = -1;
  float primaryUsedPercent = -1;
  float secondaryUsedPercent = -1;
  float primaryRemainingPercent = -1;
  float secondaryRemainingPercent = -1;
  int32_t primaryWindowMinutes = -1;
  int32_t secondaryWindowMinutes = -1;
  int32_t primaryResetsAt = -1;
  int32_t secondaryResetsAt = -1;
  String limitName = "";
  String planType = "";
  String primaryQuotaState = "unknown";
  String secondaryQuotaState = "unknown";
  String quotaAlert = "none";
  String quotaAlertLabel = "";
  String updatedAt = "";
  String source = "unavailable";
};

struct CodexSnapshot {
  bool bridgeLinked = false;
  String state = "idle";
  String label = "IDLE";
  String title = "Codex";
  String body = "Starting";
  String event = "none";
  String text = "";
  String recentUser = "";
  String recentReply = "";
  String activity = "";
  String updatedAt = "";
  UsageSnapshot usage;
};

struct HapticState {
  bool active = false;
  bool motorOn = false;
  uint8_t level = 0;
  uint8_t pulsesLeft = 0;
  uint16_t onMs = 0;
  uint16_t offMs = 0;
  uint32_t nextChangeMs = 0;
  uint32_t motorStartedMs = 0;
};

struct RuntimeConfig {
  String wifiSsid = "";
  String wifiPassword = "";
  String bridgeBaseUrl = "";
  String pairingToken = "";
  String deviceId = "";
  uint8_t brightness = 128;
};

CodexSnapshot snapshot;
HapticState haptic;
RuntimeConfig runtimeConfig;
Preferences preferences;
WebServer configServer(80);
Page page = Page::Status;
uint8_t expressionIndex = 0;
uint8_t usageMode = 0;
uint32_t lastPollMs = 0;
uint32_t lastWiFiAttemptMs = 0;
uint32_t lastRenderMs = 0;
uint32_t touchQuietUntilMs = 0;
uint32_t transientUntilMs = 0;
uint32_t lastBridgeOkMs = 0;
uint32_t affectionUntilMs = 0;
uint32_t configRestartAtMs = 0;
uint32_t configPortalStartedMs = 0;
uint32_t configPortalSuppressUntilMs = 0;
uint32_t lastPowerPolicyMs = 0;
int16_t touchStartX = 0;
int16_t touchStartY = 0;
uint32_t touchStartMs = 0;
uint8_t bridgeFailureCount = 0;
uint8_t wifiConnectFailures = 0;
bool touchSwipeHandled = false;
bool touchHoldHandled = false;
bool dirty = true;
bool hapticDirectReady = false;
bool configPortalActive = false;
bool configRoutesReady = false;
bool voiceMicReady = false;
bool voiceRecording = false;
bool voiceButtonDown = false;
bool voiceButtonStarted = false;
int16_t* voiceBuffer = nullptr;
size_t voiceSampleCount = 0;
uint32_t voiceStartedMs = 0;
uint32_t voiceButtonPressMs = 0;
String lastEvent = "none";
String lastQuotaAlert = "none";
String pendingTranscript = "";
String transientMessage = "";

String runtimeDeviceId() {
  return runtimeConfig.deviceId.length() > 0 ? runtimeConfig.deviceId : String(DEVICE_ID);
}

String cleanBridgeBaseUrl(String value) {
  value.trim();
  while (value.endsWith("/")) {
    value.remove(value.length() - 1);
  }
  return value;
}

uint8_t sanitizeBrightness(int value) {
  if (value < 32) {
    return 32;
  }
  if (value > 220) {
    return 220;
  }
  return static_cast<uint8_t>(value);
}

String bridgeUrl(const char* path) {
  String baseUrl = runtimeConfig.bridgeBaseUrl.length() > 0
    ? runtimeConfig.bridgeBaseUrl
    : String(BRIDGE_BASE_URL);
  baseUrl = cleanBridgeBaseUrl(baseUrl);
  String url = baseUrl + String(path);
  if (runtimeConfig.pairingToken.length() > 0) {
    url += "?token=" + runtimeConfig.pairingToken;
  }
  return url;
}

String stateUrl() {
  return bridgeUrl("/codex-stopwatch/state");
}

String voiceUrl() {
  return bridgeUrl("/codex-stopwatch/voice");
}

String transcriptUrl() {
  return bridgeUrl("/codex-stopwatch/transcript");
}

String shortText(const String& value, size_t maxLength) {
  if (value.length() <= maxLength) {
    return value;
  }
  return value.substring(0, maxLength - 3) + "...";
}

String shortUtf8Text(const String& value, size_t maxBytes) {
  if (value.length() <= maxBytes) {
    return value;
  }

  size_t end = maxBytes > 3 ? maxBytes - 3 : 0;
  while (end > 0 && (static_cast<uint8_t>(value[end]) & 0xC0) == 0x80) {
    --end;
  }
  return value.substring(0, end) + "...";
}

bool isAsciiWhitespace(char value) {
  return value == ' ' || value == '\n' || value == '\r' || value == '\t';
}

String trimLeadingText(const String& value) {
  size_t start = 0;
  while (start < value.length() && isAsciiWhitespace(value[start])) {
    ++start;
  }
  return value.substring(start);
}

size_t nextUtf8End(const String& value, size_t start) {
  if (start >= value.length()) {
    return value.length();
  }

  const uint8_t first = static_cast<uint8_t>(value[start]);
  size_t length = 1;
  if ((first & 0xE0) == 0xC0) {
    length = 2;
  } else if ((first & 0xF0) == 0xE0) {
    length = 3;
  } else if ((first & 0xF8) == 0xF0) {
    length = 4;
  }

  const size_t end = start + length;
  return end <= value.length() ? end : start + 1;
}

size_t previousUtf8Start(const String& value, size_t end) {
  if (end > value.length()) {
    end = value.length();
  }
  if (end == 0) {
    return 0;
  }

  size_t start = end - 1;
  while (start > 0 && (static_cast<uint8_t>(value[start]) & 0xC0) == 0x80) {
    --start;
  }
  return start;
}

String fitUtf8TextToWidth(const String& value, int maxWidth) {
  String text = value;
  text.trim();
  if (text.length() == 0 || M5.Display.textWidth(text.c_str()) <= maxWidth) {
    return text;
  }

  size_t end = 0;
  size_t lastFit = 0;
  while (end < text.length()) {
    end = nextUtf8End(text, end);
    const String candidate = text.substring(0, end);
    if (M5.Display.textWidth(candidate.c_str()) > maxWidth) {
      break;
    }
    lastFit = end;
  }

  if (lastFit == 0) {
    lastFit = nextUtf8End(text, 0);
  }
  return text.substring(0, lastFit);
}

String ellipsizeUtf8TextToWidth(const String& value, int maxWidth) {
  String text = value;
  text.replace('\n', ' ');
  text.trim();
  if (text.length() == 0 || M5.Display.textWidth(text.c_str()) <= maxWidth) {
    return text;
  }

  const String suffix = "...";
  size_t end = text.length();
  while (end > 0) {
    end = previousUtf8Start(text, end);
    String candidate = text.substring(0, end);
    candidate.trim();
    candidate += suffix;
    if (M5.Display.textWidth(candidate.c_str()) <= maxWidth) {
      return candidate;
    }
  }

  return suffix;
}

String tokenText(int32_t value) {
  if (value < 0) {
    return "--";
  }
  if (value >= 1000000) {
    return String(value / 1000000.0f, 1) + "M";
  }
  if (value >= 1000) {
    return String(value / 1000.0f, 1) + "k";
  }
  return String(value);
}

String percentText(float value) {
  if (value < 0) {
    return "--";
  }
  return String(value, 0) + "%";
}

String moneyText(float value) {
  if (value < 0) {
    return "--";
  }
  if (value >= 1000) {
    return String("$") + String(value / 1000.0f, 1) + "k";
  }
  if (value >= 100) {
    return String("$") + String(value, 1);
  }
  return String("$") + String(value, 2);
}

bool startupConnectionGraceActive() {
  return lastBridgeOkMs == 0
    && !configPortalActive
    && millis() < kStartupConnectionGraceMs;
}

String connectionIssueText() {
  if (startupConnectionGraceActive()) {
    return WiFi.status() == WL_CONNECTED ? "Connecting Mac..." : "Joining Wi-Fi...";
  }
  if (WiFi.status() != WL_CONNECTED) {
    return "Wi-Fi offline";
  }
  if (!snapshot.bridgeLinked || (lastBridgeOkMs != 0 && millis() - lastBridgeOkMs > kBridgeStaleMs)) {
    return "Bridge offline";
  }
  return "";
}

bool bridgeOnline() {
  return WiFi.status() == WL_CONNECTED
    && snapshot.bridgeLinked
    && (lastBridgeOkMs == 0 || millis() - lastBridgeOkMs <= kBridgeStaleMs);
}

float clampPercent(float value) {
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return value;
}

uint16_t usageColor(float usedPercent) {
  if (usedPercent < 0) {
    return kDim;
  }
  if (usedPercent >= 90) {
    return kError;
  }
  if (usedPercent >= 70) {
    return kWarn;
  }
  return kOk;
}

uint16_t quotaAlertColor(const String& alert) {
  if (alert == "critical") {
    return kError;
  }
  if (alert == "warn") {
    return kWarn;
  }
  return kDim;
}

uint8_t quotaAlertRank(const String& alert) {
  if (alert == "critical") {
    return 2;
  }
  if (alert == "warn") {
    return 1;
  }
  return 0;
}

String windowLabel(int32_t minutes, const char* fallback) {
  if (minutes == 300) {
    return "5h";
  }
  if (minutes == 10080) {
    return "7d";
  }
  return fallback;
}

uint16_t stateColor(const String& state) {
  if (startupConnectionGraceActive()) {
    return kAccent;
  }
  if (state == "failed" || snapshot.label == "ERROR") {
    return kError;
  }
  if (snapshot.label == "WAIT OK" || snapshot.label == "NEED INPUT" || snapshot.label == "SENT") {
    return kWarn;
  }
  if (snapshot.label == "REPLIED" || state == "review") {
    return kOk;
  }
  if (state == "thinking" || state == "running" || state == "running-left" || state == "running-right") {
    return kAccent;
  }
  if (state == "waiting") {
    return kWarn;
  }
  return kDim;
}

bool isReplySnapshot() {
  return snapshot.label == "REPLIED" || snapshot.title == "Codex replied";
}

bool isWaitingSnapshot() {
  return snapshot.label == "WAIT OK" || snapshot.label == "NEED INPUT" || snapshot.label == "SENT";
}

bool isListeningSnapshot() {
  return snapshot.label == "LISTENING";
}

bool isBusySnapshot() {
  return snapshot.label == "TRANSCRIBING" || snapshot.label == "SENDING"
    || snapshot.state == "thinking" || snapshot.state == "running"
    || snapshot.state == "running-left" || snapshot.state == "running-right";
}

bool isOfflineSnapshot() {
  if (startupConnectionGraceActive()) {
    return false;
  }
  return connectionIssueText().length() > 0;
}

bool affectionActive(uint32_t now) {
  return affectionUntilMs != 0 && now < affectionUntilMs;
}

uint8_t idleMood(uint32_t now) {
  if (snapshot.state != "idle" || !bridgeOnline()) {
    return 0;
  }
  return static_cast<uint8_t>((now / 6000) % 4);
}

bool idleAffectionMoment(uint32_t now) {
  return idleMood(now) == 3;
}

uint8_t hatchlingFrameForState() {
  if (snapshot.state == "failed" || snapshot.label == "ERROR") {
    return hatchling::kFailed0;
  }
  if (isReplySnapshot() || pendingTranscript.length() > 0) {
    return ((millis() / 640) % 2 == 0) ? hatchling::kReview0 : hatchling::kIdle5;
  }
  if (isWaitingSnapshot()) {
    return hatchling::kWaiting0;
  }
  if (snapshot.label == "LISTENING" || snapshot.state == "waiting") {
    return hatchling::kWaiting0;
  }
  if (isBusySnapshot()) {
    return hatchling::kRunning0;
  }
  uint8_t frame = expressionIndex % 6;
  if (snapshot.state == "idle" && bridgeOnline() && !affectionActive(millis())) {
    frame = (frame + static_cast<uint8_t>((millis() / 6000) % 6)) % 6;
  }
  return hatchling::kIdle0 + frame;
}

void setHapticMotor(uint8_t level) {
  if (hapticDirectReady) {
    if (level == 0) {
      uint8_t pwmOff[2] = {0x00, 0x00};
      M5.In_I2C.writeRegister(kM5IOE1Address, 0x1B, pwmOff, sizeof(pwmOff), kM5IOE1Freq);
      return;
    }

    M5.In_I2C.writeRegister8(kM5IOE1Address, 0x23, 0x00, kM5IOE1Freq);
    M5.In_I2C.bitOff(kM5IOE1Address, 0x14, 0b00000001, kM5IOE1Freq);
    M5.In_I2C.bitOn(kM5IOE1Address, 0x04, 0b00000001, kM5IOE1Freq);
    const uint16_t duty12 = static_cast<uint16_t>((static_cast<uint32_t>(level) * 0x0FFFu) / 255u);
    uint8_t pwmOn[2] = {
      static_cast<uint8_t>(duty12 & 0xFF),
      static_cast<uint8_t>(((duty12 >> 8) & 0x0Fu) | 0x80u),
    };
    M5.In_I2C.writeRegister(kM5IOE1Address, 0x1B, pwmOn, sizeof(pwmOn), kM5IOE1Freq);
    return;
  }

  M5.Power.setVibration(level);
}

void setupHapticDriver() {
  hapticDirectReady = M5.In_I2C.isEnabled() && M5.In_I2C.scanID(kM5IOE1Address, kM5IOE1Freq);
  if (hapticDirectReady) {
    uint8_t pwmFreq[2] = {
      static_cast<uint8_t>(kMotorPwmHz & 0xFF),
      static_cast<uint8_t>((kMotorPwmHz >> 8) & 0xFF),
    };
    M5.In_I2C.writeRegister8(kM5IOE1Address, 0x23, 0x00, kM5IOE1Freq);
    M5.In_I2C.writeRegister(kM5IOE1Address, 0x25, pwmFreq, sizeof(pwmFreq), kM5IOE1Freq);
    M5.In_I2C.bitOff(kM5IOE1Address, 0x14, 0b00000001, kM5IOE1Freq);
    M5.In_I2C.bitOn(kM5IOE1Address, 0x04, 0b00000001, kM5IOE1Freq);
  }
  setHapticMotor(0);
  Serial.printf("Haptic driver: %s\n", hapticDirectReady ? "M5IOE1 direct" : "M5.Power fallback");
}

void pulseHapticNow(uint8_t level, uint16_t durationMs) {
  setHapticMotor(level);
  delay(durationMs);
  setHapticMotor(0);
  haptic.active = false;
  haptic.motorOn = false;
  haptic.pulsesLeft = 0;
  haptic.motorStartedMs = 0;
}

void startHaptic(uint8_t pulses, uint16_t onMs, uint16_t offMs, uint8_t level) {
  haptic.active = pulses > 0;
  haptic.motorOn = false;
  haptic.pulsesLeft = pulses;
  haptic.onMs = onMs;
  haptic.offMs = offMs;
  haptic.level = level;
  haptic.nextChangeMs = 0;
  haptic.motorStartedMs = 0;
}

void updateHaptic() {
  if (!haptic.active) {
    return;
  }

  const uint32_t now = millis();
  if (haptic.motorOn && haptic.motorStartedMs != 0 && now - haptic.motorStartedMs > kHapticHardStopMs) {
    setHapticMotor(0);
    haptic.active = false;
    haptic.motorOn = false;
    haptic.pulsesLeft = 0;
    haptic.motorStartedMs = 0;
    Serial.println("Haptic hard stop");
    return;
  }

  if (haptic.nextChangeMs != 0 && now < haptic.nextChangeMs) {
    return;
  }

  if (!haptic.motorOn) {
    if (haptic.pulsesLeft == 0) {
      setHapticMotor(0);
      haptic.active = false;
      return;
    }
    setHapticMotor(haptic.level);
    haptic.motorOn = true;
    haptic.motorStartedMs = now;
    haptic.nextChangeMs = now + haptic.onMs;
    return;
  }

  setHapticMotor(0);
  haptic.motorOn = false;
  haptic.motorStartedMs = 0;
  haptic.pulsesLeft -= 1;
  haptic.nextChangeMs = now + haptic.offMs;
}

void triggerEventHaptic(const String& event) {
  if (event == "completed") {
    startHaptic(1, 90, 80, 150);
  } else if (event == "approval-needed" || event == "input-needed") {
    startHaptic(2, 80, 80, 180);
  } else if (event == "failed") {
    startHaptic(3, 130, 90, 220);
  }
}

void showTransient(const String& message, uint32_t durationMs) {
  transientMessage = message;
  transientUntilMs = millis() + durationMs;
  dirty = true;
}

void updateTransient() {
  if (transientMessage.length() == 0 || millis() < transientUntilMs) {
    return;
  }
  transientMessage = "";
  dirty = true;
}

String htmlEscape(const String& value) {
  String escaped;
  escaped.reserve(value.length() + 8);
  for (size_t i = 0; i < value.length(); ++i) {
    const char c = value[i];
    if (c == '&') {
      escaped += F("&amp;");
    } else if (c == '<') {
      escaped += F("&lt;");
    } else if (c == '>') {
      escaped += F("&gt;");
    } else if (c == '"') {
      escaped += F("&quot;");
    } else {
      escaped += c;
    }
  }
  return escaped;
}

void loadRuntimeConfig() {
  preferences.begin("kurisu", false);
  runtimeConfig.wifiSsid = preferences.getString("ssid", WIFI_SSID);
  runtimeConfig.wifiPassword = preferences.getString("wifiPass", WIFI_PASSWORD);
  runtimeConfig.bridgeBaseUrl = cleanBridgeBaseUrl(preferences.getString("bridge", BRIDGE_BASE_URL));
  runtimeConfig.pairingToken = preferences.getString("token", PAIRING_TOKEN);
  runtimeConfig.deviceId = preferences.getString("device", DEVICE_ID);
  runtimeConfig.brightness = sanitizeBrightness(preferences.getUChar("brightness", 128));

  if (runtimeConfig.bridgeBaseUrl.length() == 0) {
    runtimeConfig.bridgeBaseUrl = cleanBridgeBaseUrl(String(BRIDGE_BASE_URL));
  }
  if (runtimeConfig.deviceId.length() == 0) {
    runtimeConfig.deviceId = DEVICE_ID;
  }
}

void saveRuntimeConfig() {
  preferences.putString("ssid", runtimeConfig.wifiSsid);
  preferences.putString("wifiPass", runtimeConfig.wifiPassword);
  preferences.putString("bridge", runtimeConfig.bridgeBaseUrl);
  preferences.putString("token", runtimeConfig.pairingToken);
  preferences.putString("device", runtimeConfig.deviceId);
  preferences.putUChar("brightness", runtimeConfig.brightness);
}

String configPageHtml(const String& notice = "") {
  String pageHtml;
  pageHtml.reserve(4600);
  pageHtml += F("<!doctype html><html><head><meta charset='utf-8'>");
  pageHtml += F("<meta name='viewport' content='width=device-width,initial-scale=1'>");
  pageHtml += F("<title>Kurisu StopWatch</title>");
  pageHtml += F("<style>");
  pageHtml += F("body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;background:#fff;color:#1d1d1f}");
  pageHtml += F("main{max-width:520px;margin:0 auto;padding:28px 20px 36px}");
  pageHtml += F("h1{font-size:24px;margin:0 0 8px}.sub{color:#666;margin:0 0 24px}");
  pageHtml += F("label{display:block;font-size:13px;color:#555;margin:16px 0 6px}");
  pageHtml += F("input{box-sizing:border-box;width:100%;font-size:16px;padding:12px;border:1px solid #d8d8d8;border-radius:8px}");
  pageHtml += F("button{margin-top:22px;width:100%;border:0;border-radius:8px;background:#b12752;color:white;font-size:16px;padding:13px}");
  pageHtml += F(".notice{padding:10px 12px;border-radius:8px;background:#f7e8ee;color:#9a2348;margin:14px 0}");
  pageHtml += F(".hint{font-size:12px;color:#777;line-height:1.45}.row{margin-top:18px}");
  pageHtml += F("</style></head><body><main>");
  pageHtml += F("<h1>Kurisu StopWatch</h1><p class='sub'>Wi-Fi and Mac bridge setup</p>");
  if (notice.length() > 0) {
    pageHtml += F("<div class='notice'>");
    pageHtml += htmlEscape(notice);
    pageHtml += F("</div>");
  }
  pageHtml += F("<form method='post' action='/save'>");
  pageHtml += F("<label>Wi-Fi SSID</label><input name='ssid' value='");
  pageHtml += htmlEscape(runtimeConfig.wifiSsid);
  pageHtml += F("' autocomplete='off'>");
  pageHtml += F("<label>Wi-Fi Password</label><input name='password' type='password' placeholder='Leave blank to keep current password'>");
  pageHtml += F("<label>Bridge Base URL</label><input name='bridge' value='");
  pageHtml += htmlEscape(runtimeConfig.bridgeBaseUrl);
  pageHtml += F("' placeholder='http://192.168.1.2:17842'>");
  pageHtml += F("<label>Pairing Token</label><input name='token' type='password' placeholder='Leave blank to keep current token'>");
  pageHtml += F("<p class='hint'><input style='width:auto' type='checkbox' name='clearToken' value='1'> Clear pairing token</p>");
  pageHtml += F("<label>Brightness</label><input name='brightness' type='number' min='32' max='220' value='");
  pageHtml += String(runtimeConfig.brightness);
  pageHtml += F("'>");
  pageHtml += F("<label>Device Name</label><input name='device' value='");
  pageHtml += htmlEscape(runtimeConfig.deviceId);
  pageHtml += F("'>");
  pageHtml += F("<button type='submit'>Save and restart</button>");
  pageHtml += F("</form>");
  pageHtml += F("<div class='row hint'>Setup AP: ");
  pageHtml += htmlEscape(String(SETUP_AP_SSID));
  pageHtml += F(" / ");
  pageHtml += WiFi.softAPIP().toString();
  pageHtml += F("</div></main></body></html>");
  return pageHtml;
}

void setupConfigRoutes() {
  if (configRoutesReady) {
    return;
  }
  configRoutesReady = true;

  configServer.on("/", HTTP_GET, []() {
    configServer.send(200, "text/html; charset=utf-8", configPageHtml());
  });

  configServer.on("/save", HTTP_POST, []() {
    String ssid = configServer.arg("ssid");
    String bridge = configServer.arg("bridge");
    String device = configServer.arg("device");
    String password = configServer.arg("password");
    String token = configServer.arg("token");
    String brightness = configServer.arg("brightness");
    ssid.trim();
    bridge = cleanBridgeBaseUrl(bridge);
    device.trim();
    token.trim();
    brightness.trim();

    if (ssid.length() > 0) {
      runtimeConfig.wifiSsid = ssid;
    }
    if (password.length() > 0) {
      runtimeConfig.wifiPassword = password;
    }
    if (bridge.length() > 0) {
      runtimeConfig.bridgeBaseUrl = bridge;
    }
    if (configServer.hasArg("clearToken")) {
      runtimeConfig.pairingToken = "";
    } else if (token.length() > 0) {
      runtimeConfig.pairingToken = token;
    }
    if (device.length() > 0) {
      runtimeConfig.deviceId = device;
    }
    if (brightness.length() > 0) {
      runtimeConfig.brightness = sanitizeBrightness(brightness.toInt());
    }

    saveRuntimeConfig();
    configServer.send(200, "text/html; charset=utf-8", configPageHtml("Saved. Restarting StopWatch..."));
    configRestartAtMs = millis() + 900;
  });

  configServer.on("/status", HTTP_GET, []() {
    JsonDocument doc;
    doc["ok"] = true;
    doc["ssid"] = runtimeConfig.wifiSsid;
    doc["bridge"] = runtimeConfig.bridgeBaseUrl;
    doc["device"] = runtimeDeviceId();
    doc["brightness"] = runtimeConfig.brightness;
    doc["ap"] = String(SETUP_AP_SSID);
    doc["apIp"] = WiFi.softAPIP().toString();
    String payload;
    serializeJson(doc, payload);
    configServer.send(200, "application/json", payload);
  });

  configServer.onNotFound([]() {
    configServer.send(404, "text/plain", "Not found");
  });
}

bool configPortalAutoOpenSuppressed() {
  return configPortalSuppressUntilMs != 0 && millis() < configPortalSuppressUntilMs;
}

void startConfigPortal(const String& reason, bool force = false) {
  if (configPortalActive) {
    return;
  }
  if (!force && configPortalAutoOpenSuppressed()) {
    return;
  }
  if (force) {
    configPortalSuppressUntilMs = 0;
  }
  setupConfigRoutes();
  WiFi.mode(WIFI_AP_STA);
  const String apPassword = String(SETUP_AP_PASSWORD);
  const bool apStarted = apPassword.length() >= 8
    ? WiFi.softAP(SETUP_AP_SSID, SETUP_AP_PASSWORD)
    : WiFi.softAP(SETUP_AP_SSID);
  configServer.begin();
  configPortalActive = apStarted;
  configPortalStartedMs = apStarted ? millis() : 0;
  page = Page::System;
  snapshot.bridgeLinked = false;
  snapshot.title = "Setup mode";
  snapshot.body = reason.length() > 0 ? reason : WiFi.softAPIP().toString();
  startHaptic(apStarted ? 1 : 2, apStarted ? 45 : 80, 50, apStarted ? 110 : 200);
  showTransient(apStarted ? "Setup portal" : "Setup failed", 1400);
  dirty = true;
  Serial.printf("Config portal: %s at http://%s/\n", apStarted ? "started" : "failed", WiFi.softAPIP().toString().c_str());
}

void stopConfigPortal(const String& reason, bool suppressAutoOpen = true) {
  if (!configPortalActive) {
    return;
  }
  configServer.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  configPortalActive = false;
  configPortalStartedMs = 0;
  if (suppressAutoOpen) {
    configPortalSuppressUntilMs = millis() + kConfigPortalSuppressAfterCloseMs;
  }
  snapshot.title = "Setup closed";
  snapshot.body = reason.length() > 0 ? reason : "Hold A to reopen";
  startHaptic(1, 45, 40, 110);
  showTransient("Setup closed", 1400);
  dirty = true;
  Serial.printf("Config portal: stopped (%s)\n", reason.c_str());
}

void updateConfigPortal() {
  if (configPortalActive) {
    configServer.handleClient();
    if (configPortalStartedMs != 0 && millis() - configPortalStartedMs >= kConfigPortalAutoCloseMs) {
      stopConfigPortal("Timed out");
    }
  }
  if (configRestartAtMs != 0 && millis() >= configRestartAtMs) {
    Serial.println("Restarting after config save");
    ESP.restart();
  }
}

int32_t batteryLevel() {
  const int32_t level = M5.Power.getBatteryLevel();
  return (level >= 0 && level <= 100) ? level : -1;
}

bool batteryDischarging() {
  return M5.Power.isCharging() == m5::Power_Class::is_discharging;
}

uint8_t effectiveBrightness() {
  const int32_t level = batteryLevel();
  uint8_t brightness = runtimeConfig.brightness;
  if (level >= 0 && level <= 15 && batteryDischarging() && brightness > 72) {
    brightness = 72;
  }
  return brightness;
}

void updatePowerPolicy(bool force = false) {
  const uint32_t now = millis();
  if (!force && now - lastPowerPolicyMs < kPowerPolicyIntervalMs) {
    return;
  }
  lastPowerPolicyMs = now;
  M5.Display.setBrightness(effectiveBrightness());
}

String powerStatusText() {
  const int32_t level = batteryLevel();
  String text = "Power: ";
  if (level >= 0) {
    text += String(level) + "%";
  } else {
    text += "--";
  }

  const auto charging = M5.Power.isCharging();
  if (charging == m5::Power_Class::is_charging) {
    text += " USB";
  } else if (charging == m5::Power_Class::is_discharging) {
    text += " BAT";
  }
  return text;
}

String brightnessStatusText() {
  String text = "Bright: ";
  text += String(effectiveBrightness());
  if (effectiveBrightness() != runtimeConfig.brightness) {
    text += " eco";
  }
  return text;
}

void connectWiFiIfNeeded() {
  if (WiFi.status() == WL_CONNECTED) {
    wifiConnectFailures = 0;
    return;
  }
  const uint32_t now = millis();
  if (lastWiFiAttemptMs != 0 && now - lastWiFiAttemptMs < kWiFiRetryIntervalMs) {
    return;
  }
  lastWiFiAttemptMs = now;

  if (runtimeConfig.wifiSsid.length() == 0) {
    snapshot.bridgeLinked = false;
    snapshot.title = "Wi-Fi not set";
    snapshot.body = configPortalAutoOpenSuppressed() ? "Hold A on System" : "Open setup portal";
    startConfigPortal("Wi-Fi not set");
    dirty = true;
    return;
  }

  wifiConnectFailures = wifiConnectFailures < 255 ? wifiConnectFailures + 1 : wifiConnectFailures;
  if (!configPortalActive && !configPortalAutoOpenSuppressed() && wifiConnectFailures >= kWiFiSetupFailureThreshold) {
    startConfigPortal("Wi-Fi setup ready");
  }

  Serial.printf("Connecting Wi-Fi: %s\n", runtimeConfig.wifiSsid.c_str());
  WiFi.mode(configPortalActive ? WIFI_AP_STA : WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(runtimeConfig.wifiSsid.c_str(), runtimeConfig.wifiPassword.c_str());
}

void parseUsage(JsonObject usage) {
  snapshot.usage.sessionTokens = usage["sessionTokens"] | -1;
  snapshot.usage.lastTurnTokens = usage["lastTurnTokens"] | -1;
  snapshot.usage.todayTokens = usage["todayTokens"] | -1;
  snapshot.usage.todayCostUSD = usage["todayCostUSD"] | -1.0f;
  snapshot.usage.todayTurns = usage["todayTurns"] | 0;
  snapshot.usage.contextWindow = usage["contextWindow"] | -1;
  snapshot.usage.primaryUsedPercent = usage["primaryUsedPercent"] | -1.0f;
  snapshot.usage.secondaryUsedPercent = usage["secondaryUsedPercent"] | -1.0f;
  snapshot.usage.primaryRemainingPercent = usage["primaryRemainingPercent"] | -1.0f;
  snapshot.usage.secondaryRemainingPercent = usage["secondaryRemainingPercent"] | -1.0f;
  snapshot.usage.primaryWindowMinutes = usage["primaryWindowMinutes"] | -1;
  snapshot.usage.secondaryWindowMinutes = usage["secondaryWindowMinutes"] | -1;
  snapshot.usage.primaryResetsAt = usage["primaryResetsAt"] | -1;
  snapshot.usage.secondaryResetsAt = usage["secondaryResetsAt"] | -1;
  snapshot.usage.limitName = usage["limitName"] | "";
  snapshot.usage.planType = usage["planType"] | "";
  snapshot.usage.primaryQuotaState = usage["primaryQuotaState"] | "unknown";
  snapshot.usage.secondaryQuotaState = usage["secondaryQuotaState"] | "unknown";
  snapshot.usage.quotaAlert = usage["quotaAlert"] | "none";
  snapshot.usage.quotaAlertLabel = usage["quotaAlertLabel"] | "";
  snapshot.usage.updatedAt = usage["updatedAt"] | "";
  snapshot.usage.source = usage["source"] | "unavailable";
}

void maybeTriggerQuotaAlert() {
  const uint8_t currentRank = quotaAlertRank(snapshot.usage.quotaAlert);
  const uint8_t previousRank = quotaAlertRank(lastQuotaAlert);
  if (currentRank > previousRank && currentRank > 0) {
    const String label = snapshot.usage.quotaAlertLabel.length() > 0
      ? snapshot.usage.quotaAlertLabel
      : "Quota";
    showTransient(shortText(label + (snapshot.usage.quotaAlert == "critical" ? " critical" : " high"), 20), 1400);
    if (snapshot.usage.quotaAlert == "critical") {
      startHaptic(2, 95, 75, 210);
    } else {
      startHaptic(1, 80, 70, 160);
    }
  }
  lastQuotaAlert = snapshot.usage.quotaAlert;
}

void markBridgeOnline() {
  bridgeFailureCount = 0;
  lastBridgeOkMs = millis();
  snapshot.bridgeLinked = true;
}

void markBridgeFailure(const String& title, const String& body, bool immediate = false) {
  if (bridgeFailureCount < 255) {
    bridgeFailureCount += 1;
  }

  if (!immediate && startupConnectionGraceActive()) {
    Serial.printf("Bridge poll failed during startup grace: %s\n", body.c_str());
    dirty = true;
    return;
  }

  const bool stale = lastBridgeOkMs == 0 || millis() - lastBridgeOkMs > kBridgeStaleMs;
  if (!immediate && bridgeFailureCount < kBridgeFailureThreshold && !stale) {
    Serial.printf("Bridge poll failed, keeping cached state: %s\n", body.c_str());
    return;
  }

  snapshot.bridgeLinked = false;
  snapshot.title = title;
  snapshot.body = body;
  dirty = true;
}

bool applySnapshotPayload(const String& payload) {
  JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, payload);
  if (error) {
    Serial.printf("JSON parse failed: %s\n", error.c_str());
    markBridgeFailure("Bridge JSON error", error.c_str(), true);
    return false;
  }

  if (!(doc["ok"] | false)) {
    markBridgeFailure("Bridge error", doc["error"] | "Unknown", true);
    return false;
  }

  markBridgeOnline();
  snapshot.state = doc["state"] | "idle";
  snapshot.label = doc["label"] | "IDLE";
  snapshot.title = doc["title"] | "Codex";
  snapshot.body = doc["body"] | "";
  snapshot.text = doc["text"] | "";
  snapshot.event = doc["event"] | "none";
  snapshot.recentUser = doc["recent"]["user"] | "";
  snapshot.recentReply = doc["recent"]["reply"] | "";
  snapshot.activity = doc["recent"]["activity"] | "";
  snapshot.updatedAt = doc["bridge"]["updatedAt"] | "";
  parseUsage(doc["usage"].as<JsonObject>());

  if (snapshot.event != "none" && snapshot.event != lastEvent) {
    triggerEventHaptic(snapshot.event);
  }
  lastEvent = snapshot.event;
  maybeTriggerQuotaAlert();
  dirty = true;
  return true;
}

bool pollBridge(bool forced = false) {
  if (WiFi.status() != WL_CONNECTED) {
    snapshot.bridgeLinked = false;
    dirty = true;
    return false;
  }

  const uint32_t now = millis();
  if (!forced && now - lastPollMs < kPollIntervalMs) {
    return true;
  }
  lastPollMs = now;

  HTTPClient http;
  http.setConnectTimeout(700);
  http.setTimeout(2800);
  http.setReuse(false);
  http.useHTTP10(true);
  const String url = stateUrl();
  Serial.printf("GET %s\n", url.c_str());
  if (!http.begin(url)) {
    markBridgeFailure("HTTP begin failed", "Check bridge URL");
    return false;
  }
  http.addHeader("Connection", "close");

  const int code = http.GET();
  if (code != HTTP_CODE_OK) {
    markBridgeFailure("Bridge offline", String("HTTP ") + String(code));
    http.end();
    return false;
  }

  const String payload = http.getString();
  const bool ok = applySnapshotPayload(payload);
  http.end();
  return ok;
}

void render();

bool ensureVoiceBuffer() {
  if (voiceBuffer != nullptr) {
    return true;
  }
  const size_t bytes = kVoiceMaxSamples * sizeof(int16_t);
  voiceBuffer = static_cast<int16_t*>(heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (voiceBuffer == nullptr) {
    voiceBuffer = static_cast<int16_t*>(heap_caps_malloc(bytes, MALLOC_CAP_8BIT));
  }
  if (voiceBuffer == nullptr) {
    showTransient("No audio memory", 1400);
    Serial.printf("Voice buffer allocation failed: %u bytes\n", static_cast<unsigned>(bytes));
    return false;
  }
  memset(voiceBuffer, 0, bytes);
  Serial.printf("Voice buffer ready: %u bytes\n", static_cast<unsigned>(bytes));
  return true;
}

bool setupVoiceRecorder() {
  if (voiceMicReady && M5.Mic.isEnabled()) {
    return true;
  }
  M5.Speaker.end();
  auto micConfig = M5.Mic.config();
  micConfig.sample_rate = kVoiceSampleRate;
  M5.Mic.config(micConfig);
  voiceMicReady = M5.Mic.begin();
  Serial.printf("Mic driver: %s\n", voiceMicReady ? "ready" : "unavailable");
  return voiceMicReady;
}

bool parseBridgeResponse(const String& payload, JsonDocument& doc, String& errorMessage) {
  const DeserializationError error = deserializeJson(doc, payload);
  if (error) {
    errorMessage = String("JSON ") + error.c_str();
    return false;
  }
  if (!(doc["ok"] | false)) {
    errorMessage = doc["error"] | "Bridge error";
    return false;
  }
  return true;
}

void showVoiceError(const String& message) {
  snapshot.state = "failed";
  snapshot.label = "ERROR";
  snapshot.title = "Voice error";
  snapshot.body = shortText(message, 30);
  showTransient("Error", 1200);
  startHaptic(3, 120, 80, 220);
  dirty = true;
}

bool sendPendingTranscript() {
  if (pendingTranscript.length() == 0) {
    return false;
  }
  if (WiFi.status() != WL_CONNECTED) {
    showVoiceError("Wi-Fi offline");
    return false;
  }

  const String text = pendingTranscript;
  pendingTranscript = "";

  JsonDocument bodyDoc;
  bodyDoc["text"] = text;
  bodyDoc["device"] = runtimeDeviceId();
  String body;
  serializeJson(bodyDoc, body);

  snapshot.state = "running";
  snapshot.label = "SENDING";
  snapshot.title = "Sending voice";
  snapshot.body = shortText(text, 30);
  showTransient("Sending", 900);
  dirty = true;
  render();

  HTTPClient http;
  http.setConnectTimeout(900);
  http.setTimeout(30000);
  http.setReuse(false);
  http.useHTTP10(true);
  const String url = transcriptUrl();
  Serial.printf("POST %s (%u chars)\n", url.c_str(), static_cast<unsigned>(text.length()));
  if (!http.begin(url)) {
    showVoiceError("HTTP begin failed");
    return false;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Connection", "close");
  const int code = http.POST(body);
  const String payload = http.getString();
  http.end();

  JsonDocument doc;
  String errorMessage;
  if (code != HTTP_CODE_OK || !parseBridgeResponse(payload, doc, errorMessage)) {
    showVoiceError(code == HTTP_CODE_OK ? errorMessage : String("HTTP ") + String(code));
    return false;
  }

  snapshot.state = "thinking";
  snapshot.label = "SENDING";
  snapshot.title = "Sent to Codex";
  snapshot.body = "Waiting for reply";
  showTransient("Sent", 900);
  startHaptic(1, 80, 70, 150);
  lastPollMs = 0;
  dirty = true;
  return true;
}

void cancelPendingTranscript() {
  pendingTranscript = "";
  snapshot.state = "idle";
  snapshot.label = "CANCELLED";
  snapshot.title = "Voice cancelled";
  snapshot.body = "Not sent";
  showTransient("Cancelled", 900);
  startHaptic(1, 45, 40, 100);
  dirty = true;
}

bool uploadVoiceForTranscription() {
  if (WiFi.status() != WL_CONNECTED) {
    showVoiceError("Wi-Fi offline");
    return false;
  }
  if (voiceSampleCount < (kVoiceSampleRate * kVoiceMinMs) / 1000) {
    showVoiceError("Too short");
    return false;
  }

  const size_t bytes = voiceSampleCount * sizeof(int16_t);
  snapshot.state = "running";
  snapshot.label = "TRANSCRIBING";
  snapshot.title = "Transcribing";
  snapshot.body = String(bytes / 1024) + " KB audio";
  showTransient("Transcribing", 1200);
  dirty = true;
  render();

  HTTPClient http;
  http.setConnectTimeout(900);
  http.setTimeout(45000);
  http.setReuse(false);
  http.useHTTP10(true);
  const String url = voiceUrl();
  Serial.printf("POST %s (%u bytes)\n", url.c_str(), static_cast<unsigned>(bytes));
  if (!http.begin(url)) {
    showVoiceError("HTTP begin failed");
    return false;
  }
  http.addHeader("Content-Type", "application/octet-stream");
  http.addHeader("Connection", "close");
  http.addHeader("X-Audio-Encoding", "pcm-s16le");
  http.addHeader("X-Sample-Rate", String(kVoiceSampleRate));
  http.addHeader("X-Channels", "1");
  const int code = http.POST(reinterpret_cast<uint8_t*>(voiceBuffer), bytes);
  const String payload = http.getString();
  http.end();

  JsonDocument doc;
  String errorMessage;
  if (code != HTTP_CODE_OK || !parseBridgeResponse(payload, doc, errorMessage)) {
    showVoiceError(code == HTTP_CODE_OK ? errorMessage : String("HTTP ") + String(code));
    return false;
  }

  pendingTranscript = doc["transcript"] | "";
  if (pendingTranscript.length() == 0) {
    showVoiceError("No transcript");
    return false;
  }

  snapshot.state = "review";
  snapshot.label = "CONFIRM";
  snapshot.title = "Transcript";
  snapshot.body = shortText(pendingTranscript, 30);
  snapshot.text = pendingTranscript;
  showTransient("B send / A cancel", kVoiceConfirmHintMs);
  startHaptic(1, 70, 60, 140);
  dirty = true;
  return true;
}

void startVoiceRecording() {
  if (voiceRecording || pendingTranscript.length() > 0) {
    return;
  }
  if (!bridgeOnline()) {
    showVoiceError(connectionIssueText().length() > 0 ? connectionIssueText() : "Bridge offline");
    return;
  }
  if (!ensureVoiceBuffer() || !setupVoiceRecorder()) {
    showVoiceError("Mic unavailable");
    return;
  }

  voiceSampleCount = 0;
  voiceStartedMs = millis();
  voiceRecording = true;
  page = Page::Status;
  snapshot.state = "running";
  snapshot.label = "LISTENING";
  snapshot.title = "Listening";
  snapshot.body = "Hold blue B";
  showTransient("Listening", 800);
  startHaptic(1, 55, 40, 120);
  dirty = true;
}

void finishVoiceRecording(bool cancelled = false) {
  if (!voiceRecording) {
    return;
  }
  voiceRecording = false;
  while (M5.Mic.isRecording()) {
    delay(1);
  }
  if (cancelled) {
    showVoiceError("Cancelled");
    return;
  }
  uploadVoiceForTranscription();
}

void updateVoiceRecording() {
  if (!voiceRecording) {
    return;
  }
  const uint32_t elapsedMs = millis() - voiceStartedMs;
  if (elapsedMs >= kVoiceMaxMs || voiceSampleCount >= kVoiceMaxSamples) {
    finishVoiceRecording(false);
    return;
  }

  const size_t remaining = kVoiceMaxSamples - voiceSampleCount;
  const size_t chunkSamples = remaining < kVoiceChunkSamples ? remaining : kVoiceChunkSamples;
  if (chunkSamples > 0 && M5.Mic.record(&voiceBuffer[voiceSampleCount], chunkSamples, kVoiceSampleRate)) {
    voiceSampleCount += chunkSamples;
    if ((voiceSampleCount / kVoiceChunkSamples) % 25 == 0) {
      snapshot.body = String(elapsedMs / 1000.0f, 1) + "s";
      dirty = true;
    }
  }
}

bool handleVoiceButton() {
  const uint32_t now = millis();
  if (voiceRecording) {
    if (M5.BtnB.wasReleased()) {
      finishVoiceRecording(false);
    }
    return true;
  }

  if (M5.BtnB.wasPressed()) {
    voiceButtonDown = true;
    voiceButtonStarted = false;
    voiceButtonPressMs = now;
  }

  if (voiceButtonDown && M5.BtnB.isPressed() && !voiceButtonStarted
      && now - voiceButtonPressMs >= kVoiceHoldStartMs) {
    voiceButtonStarted = true;
    startVoiceRecording();
    return true;
  }

  if (voiceButtonDown && M5.BtnB.wasReleased()) {
    const bool consumed = voiceButtonStarted;
    voiceButtonDown = false;
    voiceButtonStarted = false;
    return consumed;
  }

  return voiceButtonStarted;
}

void drawHeader() {
  const int cx = M5.Display.width() / 2;
  const bool linked = bridgeOnline();
  const bool connecting = startupConnectionGraceActive() && !linked;
  const uint16_t wifiColor = WiFi.status() == WL_CONNECTED ? kOk : (connecting ? kAccent : kError);
  const uint16_t macColor = linked ? kOk : (connecting ? kAccent : kError);
  const String headerText = linked
    ? "Mac linked"
    : (connecting
        ? (WiFi.status() == WL_CONNECTED ? "Connecting Mac" : "Joining Wi-Fi")
        : "Mac offline");
  M5.Display.fillRoundRect(cx - 92, 18, 184, 30, 15, kPanel);
  M5.Display.drawRoundRect(cx - 92, 18, 184, 30, 15, kPanelLine);
  M5.Display.fillCircle(cx - 74, 33, 5, wifiColor);
  M5.Display.fillCircle(cx + 74, 33, 5, macColor);
  M5.Display.setTextDatum(middle_center);
  M5.Display.setTextColor(kText, kPanel);
  M5.Display.setFont(&fonts::Font2);
  M5.Display.drawString(headerText, cx, 33);
}

void drawConnectionNotice() {
  if (transientMessage.length() > 0) {
    return;
  }
  const String issue = connectionIssueText();
  if (issue.length() == 0) {
    return;
  }

  const int cx = M5.Display.width() / 2;
  const uint16_t color = startupConnectionGraceActive()
    ? kAccent
    : (WiFi.status() == WL_CONNECTED ? kWarn : kError);
  M5.Display.fillRoundRect(cx - 82, 54, 164, 28, 14, color);
  M5.Display.setTextDatum(middle_center);
  M5.Display.setTextColor(0xFFFF, color);
  M5.Display.setFont(&fonts::Font2);
  M5.Display.drawString(issue, cx, 68);
}

void drawHatchlingFrame(uint8_t frameId, int x, int y) {
  if (frameId >= hatchling::kFrameCount) {
    frameId = hatchling::kIdle0;
  }

  hatchling::FrameInfo info;
  memcpy_P(&info, &hatchling::kFrames[frameId], sizeof(info));

  for (uint16_t index = 0; index < info.runCount; ++index) {
    hatchling::FrameRun run;
    memcpy_P(&run, &hatchling::kRuns[info.runOffset + index], sizeof(run));
    M5.Display.drawFastHLine(x + run.x, y + run.y, run.len, run.color);
  }
}

void drawTinyHeart(int cx, int cy, uint8_t scale, uint16_t color) {
  const int s = scale < 1 ? 1 : scale;
  M5.Display.fillCircle(cx - 3 * s, cy - 2 * s, 3 * s, color);
  M5.Display.fillCircle(cx + 3 * s, cy - 2 * s, 3 * s, color);
  M5.Display.fillTriangle(cx - 7 * s, cy, cx + 7 * s, cy, cx, cy + 9 * s, color);
}

void drawSparkle(int x, int y, int r, uint16_t color) {
  M5.Display.drawLine(x - r, y, x + r, y, color);
  M5.Display.drawLine(x, y - r, x, y + r, color);
  M5.Display.drawPixel(x - r / 2, y - r / 2, color);
  M5.Display.drawPixel(x + r / 2, y + r / 2, color);
}

void drawThinkingDots(int cx, int y, uint16_t color, uint32_t now) {
  for (int i = 0; i < 3; ++i) {
    const bool active = ((now / 240) % 3) == static_cast<uint32_t>(i);
    M5.Display.fillCircle(cx + i * 14, y + (active ? -2 : 0), active ? 4 : 3, color);
  }
}

void drawListeningWaves(int x, int y, uint16_t color, uint32_t now) {
  const int phase = (now / 220) % 3;
  for (int i = 0; i < 3; ++i) {
    const int r = 7 + i * 8 + phase;
    M5.Display.drawCircle(x, y, r, color);
  }
}

void drawWaitingMark(int x, int y, uint16_t color, uint32_t now) {
  const int lift = ((now / 360) % 2) == 0 ? 0 : -2;
  M5.Display.fillRoundRect(x - 3, y - 18 + lift, 6, 18, 3, color);
  M5.Display.fillCircle(x, y + 7 + lift, 4, color);
}

void drawErrorMark(int x, int y, uint16_t color) {
  M5.Display.drawLine(x - 9, y - 9, x + 9, y + 9, color);
  M5.Display.drawLine(x + 9, y - 9, x - 9, y + 9, color);
  M5.Display.drawCircle(x, y, 15, color);
}

String companionLineForState(uint32_t now) {
  if (affectionActive(now) || idleAffectionMoment(now)) {
    return "大韦，我在";
  }
  if (startupConnectionGraceActive()) {
    return WiFi.status() == WL_CONNECTED ? "正在连 Mac" : "正在连 Wi-Fi";
  }
  if (isOfflineSnapshot()) {
    return "在找 Mac";
  }
  if (snapshot.state == "failed" || snapshot.label == "ERROR") {
    return "有点不对劲";
  }
  if (isListeningSnapshot()) {
    return "认真听你说";
  }
  if (snapshot.label == "TRANSCRIBING") {
    return "整理语音中";
  }
  if (snapshot.label == "SENDING") {
    return "帮你发出去了";
  }
  if (isWaitingSnapshot() || snapshot.state == "waiting") {
    return "等你确认";
  }
  if (isReplySnapshot()) {
    return "收到回复啦";
  }
  if (isBusySnapshot()) {
    return "正在思考";
  }
  if (snapshot.state == "idle" && bridgeOnline()) {
    const uint8_t mood = idleMood(now);
    if (mood == 1) {
      return "认真看着呢";
    }
    if (mood == 2) {
      return "哼，还不错";
    }
  }
  return ((now / 6000) % 2 == 0) ? "陪你写代码" : "安静待命";
}

void drawCompanionLine(int cx, int y, uint32_t now) {
  const bool warm = affectionActive(now) || idleAffectionMoment(now) || isReplySnapshot();
  M5.Display.setTextDatum(middle_center);
  M5.Display.setFont(&fonts::efontCN_16_b);
  M5.Display.setTextColor(warm ? kAffection : kDim, kBg);
  M5.Display.drawString(companionLineForState(now), cx, y);
}

void drawCompanionEffects(int cx, int top, uint16_t mood, uint32_t now) {
  if (affectionActive(now) || idleAffectionMoment(now) || isReplySnapshot()) {
    const int beat = ((now / 260) % 2) == 0 ? 1 : 0;
    drawTinyHeart(cx + 70, top + 38 - beat * 3, 2, kAffection);
    drawTinyHeart(cx - 76, top + 92 + beat * 2, 1, kAffection);
  }

  if (startupConnectionGraceActive()) {
    drawThinkingDots(cx + 50, top + 32, kAccent, now);
    drawSparkle(cx - 68, top + 62, 6, kSpark);
  } else if (isBusySnapshot()) {
    drawThinkingDots(cx + 50, top + 32, kAccent, now);
    drawSparkle(cx - 68, top + 62, 6, kSpark);
  } else if (isListeningSnapshot()) {
    drawListeningWaves(cx - 66, top + 95, kAccent, now);
  } else if (isWaitingSnapshot() || snapshot.state == "waiting") {
    drawWaitingMark(cx + 76, top + 72, kWarn, now);
  } else if (snapshot.state == "failed" || snapshot.label == "ERROR" || isOfflineSnapshot()) {
    drawErrorMark(cx + 74, top + 62, mood);
  } else if (snapshot.state == "idle") {
    const int drift = (now / 700) % 3;
    const uint8_t idle = idleMood(now);
    if (idle == 1) {
      drawThinkingDots(cx + 54, top + 34, kAccent, now);
      drawSparkle(cx - 64, top + 46 + drift, 5, kSpark);
    } else if (idle == 2) {
      drawSparkle(cx - 66, top + 48 + drift, 6, kSpark);
      drawSparkle(cx + 72, top + 88 - drift, 4, kSpark);
    } else {
      drawSparkle(cx - 64, top + 46 + drift, 5, kSpark);
    }
  }
}

void drawKurisu(int cx, int top) {
  const uint32_t now = millis();
  const int bob = isBusySnapshot() ? ((now / 180) % 3) - 1 : 0;
  const int sway = isBusySnapshot() ? static_cast<int>((now / 220) % 3) - 1 : 0;
  const int x = cx - hatchling::kFrameWidth / 2 + sway;
  const int y = top + bob;
  const uint16_t mood = stateColor(snapshot.state);

  M5.Display.fillCircle(cx, y + 104, 92, kHalo);
  M5.Display.drawCircle(cx, y + 104, 96, mood);
  M5.Display.drawCircle(cx, y + 104, 97, mood);
  drawHatchlingFrame(hatchlingFrameForState(), x, y);
  drawCompanionEffects(cx, top, mood, now);
  drawCompanionLine(cx, top + 232, now);
}

void drawSummaryLines(const String& value, int cx, int y, uint8_t maxLines) {
  String remaining = value;
  uint8_t drawn = 0;
  int lineY = y;

  while (drawn < maxLines && remaining.length() > 0) {
    const int newline = remaining.indexOf('\n');
    String line = newline >= 0 ? remaining.substring(0, newline) : remaining;
    line.trim();
    if (line.length() > 0) {
      M5.Display.drawString(shortUtf8Text(line, 42), cx, lineY);
      lineY += 18;
      drawn += 1;
    }
    if (newline < 0) {
      break;
    }
    remaining = remaining.substring(newline + 1);
  }

  if (drawn == 0) {
    M5.Display.drawString(shortUtf8Text(value, 42), cx, y);
  }
}

void drawWrappedEventLines(const String& value, int cx, int y, int maxWidth, uint8_t maxLines) {
  String remaining = value.length() > 0 ? value : "No recent item";
  remaining.replace('\n', ' ');
  remaining = shortUtf8Text(remaining, 180);

  for (uint8_t drawn = 0; drawn < maxLines; ++drawn) {
    remaining = trimLeadingText(remaining);
    if (remaining.length() == 0) {
      break;
    }

    const bool lastLine = drawn == maxLines - 1;
    const int ellipsisWidth = lastLine ? 24 : 0;
    const int lineWidth = maxWidth - ellipsisWidth;
    int usedWidth = 0;
    size_t end = 0;
    size_t lastSpace = 0;

    while (end < remaining.length()) {
      const char first = remaining[end];
      if (first == '\n' || first == '\r') {
        break;
      }
      const size_t next = nextUtf8End(remaining, end);
      const uint8_t lead = static_cast<uint8_t>(first);
      const int charWidth = lead < 0x80 ? 8 : 16;
      if (usedWidth + charWidth > lineWidth) {
        break;
      }
      if (first == ' ') {
        lastSpace = next;
      }
      usedWidth += charWidth;
      end = next;
    }

    if (end == 0) {
      end = nextUtf8End(remaining, 0);
    } else if (!lastLine && lastSpace > 0 && end < remaining.length()) {
      end = lastSpace;
    }

    String line = remaining.substring(0, end);
    line.trim();
    remaining = remaining.substring(end);

    if (lastLine) {
      remaining = trimLeadingText(remaining);
      if (remaining.length() > 0) {
        line += "...";
      }
    }

    M5.Display.drawString(line, cx, y + drawn * 18);
  }
}

String statusTitleLine() {
  if (isReplySnapshot()) {
    return "Codex replied";
  }
  if (snapshot.title.length() > 0 && snapshot.title != "Codex") {
    return snapshot.title;
  }
  return "牧濑红莉栖";
}

void drawStatusPage() {
  const int cx = M5.Display.width() / 2;
  drawKurisu(cx, 84);

  M5.Display.setTextDatum(middle_center);
  M5.Display.setFont(&fonts::Font4);
  M5.Display.setTextColor(stateColor(snapshot.state), kBg);
  M5.Display.drawString(snapshot.label, cx, 338);

  M5.Display.setFont(&fonts::efontCN_16_b);
  M5.Display.setTextColor(kText, kBg);
  M5.Display.drawString(shortUtf8Text(statusTitleLine(), 44), cx, 371);
  M5.Display.setTextColor(kDim, kBg);
  M5.Display.setFont(&fonts::efontCN_16_b);
  drawSummaryLines(snapshot.body.length() > 0 ? snapshot.body : snapshot.text, cx, 394, isReplySnapshot() ? 3 : 2);

  if (pendingTranscript.length() > 0) {
    M5.Display.setTextColor(kAccent, kBg);
    M5.Display.drawString("B send / A cancel", cx, 425);
  }
}

void drawEventBlock(int cx, int y, const String& label, const String& value, uint16_t color) {
  M5.Display.setTextDatum(middle_center);
  M5.Display.setFont(&fonts::efontCN_16_b);
  M5.Display.setTextColor(color, kPanel);
  M5.Display.drawString(label, cx, y);
  M5.Display.setFont(&fonts::efontCN_16_b);
  M5.Display.setTextColor(kText, kPanel);
  drawWrappedEventLines(value, cx, y + 28, 208, 3);
}

void drawEventsPage() {
  const int cx = M5.Display.width() / 2;
  M5.Display.fillRoundRect(cx - 122, 72, 244, 278, 14, kPanel);
  M5.Display.drawRoundRect(cx - 122, 72, 244, 278, 14, kPanelLine);

  M5.Display.setTextDatum(middle_center);
  M5.Display.setFont(&fonts::Font4);
  M5.Display.setTextColor(kAccent, kPanel);
  M5.Display.drawString("EVENTS", cx, 104);

  drawEventBlock(cx, 138, "大韦", snapshot.recentUser, kWarn);
  drawEventBlock(
    cx,
    244,
    "牧濑红莉栖",
    snapshot.recentReply.length() > 0 ? snapshot.recentReply : snapshot.text,
    kOk);

  M5.Display.setFont(&fonts::Font2);
  M5.Display.setTextColor(kDim, kPanel);
  M5.Display.drawString(snapshot.activity.length() > 0 ? shortText(snapshot.activity, 24) : "desktop sync", cx, 326);
}

void drawQuotaRow(int x, int y, int w, const String& label, float usedPercent, float remainingPercent) {
  const int barH = 13;
  const int fillW = static_cast<int>((w * clampPercent(usedPercent)) / 100.0f);
  const uint16_t color = usageColor(usedPercent);

  M5.Display.setFont(&fonts::Font2);
  M5.Display.setTextDatum(top_left);
  M5.Display.setTextColor(kText, kPanel);
  M5.Display.drawString(label, x, y);

  M5.Display.setTextDatum(top_right);
  M5.Display.setTextColor(color, kPanel);
  M5.Display.drawString(percentText(usedPercent), x + w, y);

  M5.Display.fillRoundRect(x, y + 29, w, barH, 6, kTrack);
  if (fillW > 0) {
    M5.Display.fillRoundRect(x, y + 29, fillW, barH, 6, color);
  }

  M5.Display.setTextDatum(top_right);
  M5.Display.setTextColor(kDim, kPanel);
  M5.Display.drawString(percentText(remainingPercent) + " left", x + w, y + 49);
}

void drawMiniQuota(int x, int y, int w, const String& label, float usedPercent) {
  const int fillW = static_cast<int>((w * clampPercent(usedPercent)) / 100.0f);
  const uint16_t color = usageColor(usedPercent);
  M5.Display.setTextDatum(top_left);
  M5.Display.setTextColor(kDim, kPanel);
  M5.Display.setFont(&fonts::Font2);
  M5.Display.drawString(label, x, y);
  M5.Display.fillRoundRect(x, y + 20, w, 10, 5, kTrack);
  if (fillW > 0) {
    M5.Display.fillRoundRect(x, y + 20, fillW, 10, 5, color);
  }
}

void drawMetricLabel(int cx, int y, const String& text, uint16_t color) {
  M5.Display.fillRoundRect(cx - 52, y, 104, 24, 12, kPanel);
  M5.Display.drawRoundRect(cx - 52, y, 104, 24, 12, kPanelLine);
  M5.Display.setTextDatum(middle_center);
  M5.Display.setTextColor(color, kPanel);
  M5.Display.setFont(&fonts::Font2);
  M5.Display.drawString(text, cx, y + 12);
}

String usageFooterText() {
  if (quotaAlertRank(snapshot.usage.quotaAlert) > 0) {
    const String label = snapshot.usage.quotaAlertLabel.length() > 0
      ? snapshot.usage.quotaAlertLabel
      : "Quota";
    return shortText(label + (snapshot.usage.quotaAlert == "critical" ? " critical" : " high"), 22);
  }
  if (snapshot.usage.source.indexOf("codexbar") >= 0) {
    return "CodexBar synced";
  }
  if (snapshot.usage.source.indexOf("codex-app-server") >= 0) {
    return "Quota synced";
  }
  if (snapshot.usage.source == "unavailable") {
    return "Usage unavailable";
  }
  return "Usage logs";
}

void drawUsageFooter(int cx) {
  const bool alerting = quotaAlertRank(snapshot.usage.quotaAlert) > 0;
  const uint16_t color = alerting ? quotaAlertColor(snapshot.usage.quotaAlert) : kDim;
  M5.Display.setTextDatum(middle_center);
  M5.Display.setFont(&fonts::Font2);
  if (alerting) {
    M5.Display.fillRoundRect(cx - 82, 370, 164, 24, 12, kBg);
    M5.Display.drawRoundRect(cx - 82, 370, 164, 24, 12, color);
  }
  M5.Display.setTextColor(color, alerting ? kBg : kBg);
  M5.Display.drawString(usageFooterText(), cx, 382);
}

void drawUsagePage() {
  const int cx = M5.Display.width() / 2;
  M5.Display.fillRoundRect(cx - 122, 72, 244, 278, 14, kPanel);
  M5.Display.drawRoundRect(cx - 122, 72, 244, 278, 14, kPanelLine);
  M5.Display.setTextDatum(middle_center);
  M5.Display.setFont(&fonts::Font4);
  M5.Display.setTextColor(kAccent, kPanel);

  if (usageMode == 0) {
    M5.Display.drawString("QUOTA", cx, 108);
    drawQuotaRow(
      cx - 96,
      144,
      192,
      windowLabel(snapshot.usage.primaryWindowMinutes, "5h"),
      snapshot.usage.primaryUsedPercent,
      snapshot.usage.primaryRemainingPercent);
    drawQuotaRow(
      cx - 96,
      235,
      192,
      windowLabel(snapshot.usage.secondaryWindowMinutes, "7d"),
      snapshot.usage.secondaryUsedPercent,
      snapshot.usage.secondaryRemainingPercent);
  } else if (usageMode == 1) {
    M5.Display.drawString("TODAY", cx, 112);
    drawMetricLabel(cx, 142, "TOKENS", kAccent);
    M5.Display.setFont(&fonts::Font7);
    M5.Display.drawString(tokenText(snapshot.usage.todayTokens), cx, 210);
    M5.Display.setFont(&fonts::Font2);
    M5.Display.setTextColor(kText, kPanel);
    M5.Display.drawString(String(snapshot.usage.todayTurns) + " turns", cx, 286);
    drawMiniQuota(
      cx - 96,
      310,
      84,
      windowLabel(snapshot.usage.primaryWindowMinutes, "5h"),
      snapshot.usage.primaryUsedPercent);
    drawMiniQuota(
      cx + 12,
      310,
      84,
      windowLabel(snapshot.usage.secondaryWindowMinutes, "7d"),
      snapshot.usage.secondaryUsedPercent);
  } else {
    M5.Display.drawString("COST", cx, 126);
    drawMetricLabel(cx, 156, "TODAY", kOk);
    M5.Display.setFont(&fonts::Font7);
    M5.Display.drawString(moneyText(snapshot.usage.todayCostUSD), cx, 210);
    M5.Display.setFont(&fonts::Font2);
    M5.Display.setTextColor(kText, kPanel);
    M5.Display.drawString("CodexBar today", cx, 276);
    M5.Display.setTextColor(kDim, kPanel);
    M5.Display.drawString(tokenText(snapshot.usage.todayTokens) + " tokens", cx, 306);
  }

  drawUsageFooter(cx);
}

void drawSystemPage() {
  const int cx = M5.Display.width() / 2;
  M5.Display.setTextDatum(middle_center);
  M5.Display.setFont(&fonts::Font4);
  M5.Display.setTextColor(kAccent, kBg);
  M5.Display.drawString("SYSTEM", cx, 108);

  M5.Display.setFont(&fonts::Font2);
  M5.Display.setTextColor(kText, kBg);
  M5.Display.setTextColor(WiFi.status() == WL_CONNECTED ? kOk : kError, kBg);
  M5.Display.drawString(String("Wi-Fi: ") + String(WiFi.status() == WL_CONNECTED ? "OK" : "OFF"), cx, 154);
  const bool bridgeLinked = bridgeOnline();
  const bool bridgeConnecting = startupConnectionGraceActive() && !bridgeLinked;
  M5.Display.setTextColor(bridgeLinked ? kOk : (bridgeConnecting ? kAccent : kError), kBg);
  M5.Display.drawString(String("Bridge: ") + String(bridgeLinked ? "OK" : (bridgeConnecting ? "..." : "OFF")), cx, 186);
  M5.Display.setTextColor(kText, kBg);
  M5.Display.drawString(powerStatusText(), cx, 218);
  M5.Display.drawString(brightnessStatusText(), cx, 250);
  M5.Display.drawString(String("IP: ") + WiFi.localIP().toString(), cx, 282);
  M5.Display.setTextColor(kDim, kBg);
  if (configPortalActive) {
    M5.Display.drawString(String("Setup: ") + WiFi.softAPIP().toString(), cx, 318);
    M5.Display.drawString(String("AP: ") + shortText(String(SETUP_AP_SSID), 20), cx, 346);
    M5.Display.drawString("Hold A: close setup", cx, 382);
  } else {
    M5.Display.drawString("Hold A: setup", cx, 318);
    M5.Display.drawString(shortText(snapshot.updatedAt, 30), cx, 346);
    M5.Display.drawString("Hold screen: refresh", cx, 382);
  }
}

void drawTransientBanner() {
  if (transientMessage.length() == 0) {
    return;
  }
  const int cx = M5.Display.width() / 2;
  const int y = 54;
  M5.Display.fillRoundRect(cx - 82, y, 164, 28, 14, kAccent);
  M5.Display.setTextDatum(middle_center);
  M5.Display.setTextColor(0xFFFF, kAccent);
  M5.Display.setFont(&fonts::Font2);
  M5.Display.drawString(transientMessage, cx, y + 14);
}

void drawFooter() {
  const int cx = M5.Display.width() / 2;
  const int y = M5.Display.height() - 28;
  const int startX = cx - ((kPageCount - 1) * 22) / 2;
  for (int i = 0; i < kPageCount; ++i) {
    const int x = startX + i * 22;
    const bool active = static_cast<int>(page) == i;
    M5.Display.fillCircle(x, y, active ? 5 : 3, active ? kAccent : kDim);
  }
}

void render() {
  const uint32_t now = millis();
  if (!dirty) {
    if (page != Page::Status || now < touchQuietUntilMs) {
      return;
    }
    if (now - lastRenderMs < kStatusAnimationIntervalMs) {
      return;
    }
  }
  lastRenderMs = now;
  dirty = false;

  M5.Display.startWrite();
  M5.Display.fillScreen(kBg);
  drawHeader();
  if (page == Page::Status) {
    drawStatusPage();
  } else if (page == Page::Events) {
    drawEventsPage();
  } else if (page == Page::Usage) {
    drawUsagePage();
  } else {
    drawSystemPage();
  }
  drawFooter();
  drawConnectionNotice();
  drawTransientBanner();
  M5.Display.endWrite();
}

void nextPage() {
  page = static_cast<Page>((static_cast<int>(page) + 1) % kPageCount);
  dirty = true;
}

void previousPage() {
  page = static_cast<Page>((static_cast<int>(page) + kPageCount - 1) % kPageCount);
  dirty = true;
}

void refreshBridgeWithFeedback() {
  showTransient("Refreshing", 900);
  render();
  pulseHapticNow(255, 130);
  const bool ok = pollBridge(true);
  showTransient(ok ? "Updated" : "Retry failed", 900);
  if (ok) {
    startHaptic(1, 55, 40, 150);
  } else {
    startHaptic(2, 90, 70, 220);
  }
}

void handleButtons() {
  if (pendingTranscript.length() > 0) {
    if (M5.BtnA.wasClicked() || M5.BtnA.wasHold()) {
      cancelPendingTranscript();
      return;
    }
    if (M5.BtnB.wasClicked()) {
      sendPendingTranscript();
      return;
    }
  }

  if (handleVoiceButton()) {
    return;
  }

  if (M5.BtnA.wasClicked()) {
    if (page == Page::Usage) {
      usageMode = (usageMode + 2) % 3;
    } else {
      previousPage();
    }
    dirty = true;
  }
  if (M5.BtnB.wasClicked()) {
    if (page == Page::Usage) {
      usageMode = (usageMode + 1) % 3;
    } else {
      nextPage();
    }
    dirty = true;
  }
  if (M5.BtnA.wasHold()) {
    if (page == Page::System) {
      if (configPortalActive) {
        stopConfigPortal("Manual close");
      } else {
        startConfigPortal("Manual setup", true);
      }
    } else {
      refreshBridgeWithFeedback();
    }
  }
}

void handleTouch() {
  const auto touch = M5.Touch.getDetail();
  const uint32_t now = millis();

  if (touch.isPressed()) {
    touchQuietUntilMs = now + kTouchQuietAfterMs;
  }
  if (touch.wasPressed()) {
    touchStartX = touch.x;
    touchStartY = touch.y;
    touchStartMs = now;
    touchSwipeHandled = false;
    touchHoldHandled = false;
  }

  const int16_t dx = touch.x - touchStartX;
  const int16_t dy = touch.y - touchStartY;
  const int16_t absDx = abs(dx);
  const int16_t absDy = abs(dy);

  if (touch.isPressed() && !touchSwipeHandled && absDx > 30 && absDx > absDy + 8) {
    if (dx < 0) {
      nextPage();
    } else {
      previousPage();
    }
    touchSwipeHandled = true;
    pulseHapticNow(90, 25);
  }

  const bool steadyHold = touch.isHolding() && absDx < 22 && absDy < 22 && now - touchStartMs > 650;
  if (!touchHoldHandled && (touch.wasHold() || steadyHold)) {
    touchHoldHandled = true;
    touchSwipeHandled = true;
    refreshBridgeWithFeedback();
  }

  if (touch.wasClicked() && !touchSwipeHandled && !touchHoldHandled) {
    if (page == Page::Usage) {
      usageMode = (usageMode + 1) % 3;
    } else if (page == Page::Status) {
      expressionIndex = (expressionIndex + 1) % 6;
      affectionUntilMs = now + 2200;
      startHaptic(1, 35, 30, 80);
    }
    dirty = true;
  }
  if (!touchSwipeHandled && touch.wasFlicked()) {
    if (touch.distanceX() < -40) {
      nextPage();
    } else if (touch.distanceX() > 40) {
      previousPage();
    }
  }
}

}  // namespace

void setup() {
  Serial.begin(115200);
  auto cfg = M5.config();
  cfg.serial_baudrate = 115200;
  M5.begin(cfg);
  loadRuntimeConfig();
  setupHapticDriver();
  setupVoiceRecorder();
  updatePowerPolicy(true);
  M5.Display.setTextWrap(false);
  M5.Touch.setHoldThresh(700);
  M5.Touch.setFlickThresh(36);

  snapshot.title = "Kurisu booting";
  snapshot.body = "Connecting Mac...";
  render();
  connectWiFiIfNeeded();
}

void loop() {
  M5.update();
  updateConfigPortal();
  updatePowerPolicy();
  connectWiFiIfNeeded();
  handleButtons();
  handleTouch();
  updateVoiceRecording();
  if (!voiceRecording && pendingTranscript.length() == 0 && millis() >= touchQuietUntilMs) {
    pollBridge();
  }
  updateHaptic();
  updateTransient();
  render();
  delay(8);
}
