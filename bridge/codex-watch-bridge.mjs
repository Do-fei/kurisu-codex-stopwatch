#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile, execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const port = Number(process.env.CODEX_WATCH_PORT || 17842);
const host = process.env.CODEX_WATCH_HOST || "::";
const audioDir = path.join(process.cwd(), ".codex-watch", "audio");
const defaultCodexSessionsDir = path.join(os.homedir(), ".codex", "sessions");
const defaultCodexBarWidgetSnapshot = path.join(
  os.homedir(),
  "Library",
  "Group Containers",
  "Y5PE65HELJ.com.steipete.codexbar",
  "widget-snapshot.json"
);
const defaultCodexBarCostUsage = path.join(
  os.homedir(),
  "Library",
  "Caches",
  "CodexBar",
  "cost-usage",
  "codex-v8.json"
);
const codexAPIBaseURL = (process.env.CODEX_WATCH_CODEX_API_BASE_URL || "https://chatgpt.com/backend-api")
  .replace(/\/+$/, "");
const defaultTranscriptionModel = "gpt-4o-mini-transcribe";
const showNetworkHints = process.env.CODEX_WATCH_SHOW_NETWORK_HINTS === "1";
const verboseBridgeLogging = process.env.CODEX_WATCH_VERBOSE === "1";
let codexAppServer = null;
const clients = new Set();
const httpClients = new Map();
const durableStateBySelection = new Map();
const readStateSignaturesBySelection = new Map();
let latestDurableState = null;
let latestBridgeState = null;
let cachedStopWatchUsage = null;
let stopWatchUsageRefreshPromise = null;

export function createBridgeServer() {
  const server = http.createServer(async (request, response) => {
    const requestURL = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (requestURL.pathname === "/") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        endpoint: "/codex-watch",
        stopWatchEndpoint: "/codex-stopwatch/state",
        clients: clients.size,
        tokenRequired: Boolean(currentPairingToken()),
        port: boundPort(server)
      }));
      return;
    }

    if (requestURL.pathname === "/codex-stopwatch/state" && request.method === "GET") {
      if (!isAuthorizedRequest(requestURL)) {
        jsonResponse(response, 401, { ok: false, error: "Unauthorized StopWatch client." });
        return;
      }
      jsonResponse(response, 200, await buildStopWatchSnapshot(server));
      return;
    }

    if (requestURL.pathname === "/codex-stopwatch/voice" && request.method === "POST") {
      if (!isAuthorizedRequest(requestURL)) {
        jsonResponse(response, 401, { ok: false, error: "Unauthorized StopWatch client." });
        return;
      }
      try {
        const client = getStopWatchHTTPClient(request.socket);
        const audio = await readRequestBuffer(request, Number(process.env.CODEX_STOPWATCH_MAX_AUDIO_BYTES || 2 * 1024 * 1024));
        jsonResponse(response, 200, await handleStopWatchVoiceUpload(client, audio, request.headers));
      } catch (error) {
        jsonResponse(response, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (requestURL.pathname === "/codex-stopwatch/transcript" && request.method === "POST") {
      if (!isAuthorizedRequest(requestURL)) {
        jsonResponse(response, 401, { ok: false, error: "Unauthorized StopWatch client." });
        return;
      }
      try {
        const client = getStopWatchHTTPClient(request.socket);
        const message = JSON.parse(await readRequestBody(request));
        jsonResponse(response, 200, await handleStopWatchTranscriptSend(client, message));
      } catch (error) {
        jsonResponse(response, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (requestURL.pathname === "/codex-watch/message" && request.method === "POST") {
      if (!isAuthorizedRequest(requestURL)) {
        jsonResponse(response, 401, { ok: false, error: "Unauthorized watch client." });
        return;
      }
      try {
        const client = getHTTPClient(clientIDFromURL(requestURL), request.socket);
        const message = JSON.parse(await readRequestBody(request));
        handleText(client, JSON.stringify(message));
        jsonResponse(response, 200, { ok: true, messages: drainQueuedMessages(client) });
      } catch (error) {
        jsonResponse(response, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (requestURL.pathname === "/codex-watch/poll" && request.method === "GET") {
      if (!isAuthorizedRequest(requestURL)) {
        jsonResponse(response, 401, { ok: false, error: "Unauthorized watch client." });
        return;
      }
      const client = getHTTPClient(clientIDFromURL(requestURL), request.socket);
      jsonResponse(response, 200, { ok: true, messages: drainQueuedMessages(client) });
      return;
    }

    response.writeHead(404);
    response.end();
  });

  server.on("upgrade", (request, socket) => {
    const requestURL = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (requestURL.pathname !== "/codex-watch" || !isAuthorizedRequest(requestURL)) {
      socket.destroy();
      return;
    }

    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");

    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n"));

    const client = {
      socket,
      buffer: Buffer.alloc(0),
      audioStream: null,
      audioPath: null,
      audioBytes: 0,
      audioSampleRate: 48000,
      audioChannels: 1,
      pet: "codex",
      capabilities: [],
      selection: {
        target: "chat",
        project: "project-1",
        chat: "chat-1",
        projectIndex: 0,
        chatIndex: 0,
        newChat: false
      },
      pickerItems: loadCodexPickerItems()
    };
    clients.add(client);
    logConnection("watch connected", socket);

    send(client, {
      type: "state",
      pet: "codex",
      state: "idle",
      title: "Codex",
      body: "Bridge linked",
      items: client.pickerItems,
      ...client.selection
    });

    socket.on("data", chunk => {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      drainFrames(client);
    });
    socket.on("close", () => closeClient(client));
    socket.on("error", () => closeClient(client));
  });

  return server;
}

export function startBridge({ port: listenPort = port, host: listenHost = host } = {}) {
  fs.mkdirSync(audioDir, { recursive: true });
  const server = createBridgeServer();
  server.listen(listenPort, listenHost, () => {
    const activePort = boundPort(server);
    console.log(`Codex Watch bridge listening on port ${activePort} at /codex-watch`);
    if (showNetworkHints) {
      console.log(`LAN URL: ws://${lanAddress()}:${activePort}${watchEndpointPath()}`);
      console.log(`Hostname URL: ws://${localHostName()}.local:${activePort}${watchEndpointPath()}`);
      console.log(`Simulator URL: ws://127.0.0.1:${activePort}${watchEndpointPath()}`);
    } else {
      console.log("Set CODEX_WATCH_SHOW_NETWORK_HINTS=1 to print connection URLs.");
    }
  });
  return server;
}

if (isMainModule()) {
  startBridge();
}

function drainFrames(client) {
  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const opcode = first & 0x0f;
    const second = client.buffer[1];
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (client.buffer.length < offset + 2) return;
      length = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (client.buffer.length < offset + 8) return;
      const bigLength = client.buffer.readBigUInt64BE(offset);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        client.socket.destroy();
        return;
      }
      length = Number(bigLength);
      offset += 8;
    }

    let maskKey = null;
    if (masked) {
      maskKey = client.buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (client.buffer.length < offset + length) return;

    let payload = client.buffer.subarray(offset, offset + length);
    client.buffer = client.buffer.subarray(offset + length);

    if (maskKey) {
      const unmasked = Buffer.alloc(payload.length);
      for (let index = 0; index < payload.length; index += 1) {
        unmasked[index] = payload[index] ^ maskKey[index % 4];
      }
      payload = unmasked;
    }

    if (opcode === 0x8) {
      closeClient(client, { replyClose: true });
      return;
    }
    if (opcode === 0x1) {
      handleText(client, payload.toString("utf8"));
    }
  }
}

function handleText(client, text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    send(client, { type: "error", body: "Invalid JSON" });
    return;
  }
  if (typeof message.pet === "string" && message.pet.length > 0) {
    client.pet = message.pet;
  }
  updateClientSelection(client, message);
  if (Array.isArray(message.capabilities)) {
    client.capabilities = message.capabilities.filter(value => typeof value === "string");
  }

  switch (message.type) {
    case "hello":
      console.log("hello", client.pet, client.capabilities.join(",") || "no-capabilities");
      maybeOpenCodex();
      send(client, replayStateForClient(client) ?? {
        type: "state",
        pet: client.pet,
        state: "idle",
        title: "Codex",
        body: "Bridge ready",
        capabilities: client.capabilities,
        items: client.pickerItems,
        ...client.selection
      });
      refreshClientStateFromCodex(client).catch(error => {
        warnBridge("state refresh failed", error);
      });
      break;
    case "state":
    case "pet-selected":
      console.log(message.type, client.pet, message.state || "idle");
      broadcast({
        type: "state",
        pet: client.pet,
        state: message.state || "idle",
        title: typeof message.title === "string" ? message.title : "Codex",
        body: typeof message.body === "string" ? message.body : "Pet synced",
        text: typeof message.text === "string" ? message.text : undefined,
        capabilities: client.capabilities,
        items: client.pickerItems,
        ...client.selection
      });
      break;
    case "picker-items":
      updateClientPickerItems(client, message);
      broadcast({
        type: "picker-items",
        pet: client.pet,
        state: message.state || "idle",
        capabilities: client.capabilities,
        items: client.pickerItems,
        ...client.selection
      });
      break;
    case "picker-opened":
      console.log("picker-opened", client.selection.target);
      client.pickerItems = loadCodexPickerItems();
      send(client, {
        type: "picker-items",
        pet: client.pet,
        state: message.state || "idle",
        capabilities: client.capabilities,
        items: client.pickerItems,
        ...client.selection
      });
      break;
    case "selection-focus":
    case "project-selected":
    case "chat-selected":
      handleSelection(client, message);
      break;
    case "mic-start":
      console.log("mic-start", client.pet);
      startAudio(client, message);
      break;
    case "mic-chunk":
      appendAudio(client, message);
      break;
    case "mic-stop":
      console.log("mic-stop");
      stopAudio(client);
      break;
    case "transcript":
      console.log("transcript", `${String(message.text || message.body || "").length} chars`);
      broadcast({
        type: "transcript",
        pet: client.pet,
        state: "review",
        title: typeof message.title === "string" ? message.title : "Transcript",
        body: typeof message.body === "string" ? message.body : message.text,
        text: typeof message.text === "string" ? message.text : message.body,
        capabilities: client.capabilities,
        items: client.pickerItems,
        ...client.selection
      });
      break;
    case "transcript-send":
      handleTranscriptSend(client, message);
      break;
    case "message-read":
      clearDurableStateForClient(client);
      break;
    case "transcribe-again":
      console.log("transcribe-again");
      sendTranscribingState(client, {
        bytes: Number.isInteger(message.bytes) ? message.bytes : 0,
        savedPath: null
      });
      break;
    case "ping":
      send(client, { type: "pong" });
      break;
    default:
      send(client, { type: "error", body: `Unknown message type: ${message.type}` });
  }
}

function currentPairingToken() {
  return process.env.CODEX_WATCH_PAIRING_TOKEN || "";
}

function isAuthorizedRequest(requestURL) {
  const token = currentPairingToken();
  if (!token) {
    return true;
  }
  return requestURL.searchParams.get("token") === token;
}

function watchEndpointPath() {
  const token = currentPairingToken();
  return token ? `/codex-watch?token=${encodeURIComponent(token)}` : "/codex-watch";
}

export function codexInputTextForTranscript(text) {
  return [
    "除非用户明确要求使用其他语言，否则请用简体中文回复。",
    "以下是 Codex companion 语音转写内容：",
    "",
    text
  ].join("\n");
}

async function handleStopWatchVoiceUpload(client, audio, headers = {}) {
  if (!Buffer.isBuffer(audio) || audio.length === 0) {
    throw new Error("No StopWatch audio was received.");
  }

  const sampleRate = positiveHeaderInteger(headers["x-sample-rate"]) || 16000;
  const channels = positiveHeaderInteger(headers["x-channels"]) || 1;
  const encoding = String(headers["x-audio-encoding"] || "pcm-s16le").toLowerCase();
  if (encoding !== "pcm-s16le") {
    throw new Error(`Unsupported StopWatch audio encoding: ${encoding}`);
  }
  if (channels !== 1) {
    throw new Error("Only mono StopWatch audio is supported in V3.");
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rawPath = path.join(audioDir, `${stamp}.stopwatch.pcm-s16le.raw`);
  const wavPath = rawPath.replace(/\.pcm-s16le\.raw$/, ".wav");
  fs.writeFileSync(rawPath, audio);
  writePCM16Wav(rawPath, wavPath, { sampleRate, channels });

  send(client, {
    type: "state",
    pet: client.pet,
    state: "running",
    title: "Transcribing",
    body: "Processing StopWatch audio",
    bytes: audio.length,
    path: rawPath,
    capabilities: client.capabilities,
    items: client.pickerItems,
    ...client.selection
  });

  const text = (await transcribeAudio(wavPath)).trim();
  if (!text) {
    throw new Error("Transcription returned no text.");
  }

  send(client, {
    type: "state",
    pet: client.pet,
    state: "review",
    title: "Transcript",
    body: text,
    text,
    bytes: audio.length,
    path: wavPath,
    capabilities: client.capabilities,
    items: client.pickerItems,
    ...client.selection
  });

  return {
    ok: true,
    transcript: text,
    bytes: audio.length,
    sampleRate,
    channels
  };
}

async function handleStopWatchTranscriptSend(client, message = {}) {
  const text = String(message.text || message.body || "").trim();
  if (!text) {
    throw new Error("Transcript was empty.");
  }
  updateClientSelection(client, message);
  const target = resolveTranscriptTarget(client, message);
  if (!target) {
    throw new Error("Pick a Codex chat before sending.");
  }

  if (stopWatchTranscriptSendMode() === "visible-ui") {
    return await handleStopWatchVisibleTranscriptSend(client, target, text);
  }

  send(client, {
    type: "state",
    pet: client.pet,
    state: "running",
    title: target.newChat ? "Starting chat" : "Sending",
    body: truncate(text, 140),
    capabilities: client.capabilities,
    items: client.pickerItems,
    ...client.selection
  });

  await submitTranscriptToResolvedTarget(client, target, text);
  return {
    ok: true,
    text,
    chat: client.selection.chat || target.threadId || null,
    project: client.selection.project || target.project || null
  };
}

async function handleStopWatchVisibleTranscriptSend(client, target, text) {
  const startedAtMs = Date.now();
  applyTranscriptTargetSelection(client, target.item, target.threadId || client.selection.chat);
  send(client, {
    type: "state",
    pet: client.pet,
    state: "running",
    title: "Sending to Codex",
    body: truncate(text, 140),
    capabilities: client.capabilities,
    items: client.pickerItems,
    ...client.selection
  });

  await sendTranscriptToCodexDesktopUI(text);
  send(client, {
    type: "state",
    pet: client.pet,
    state: "thinking",
    title: "Codex UI sent",
    body: "Watching desktop reply",
    capabilities: client.capabilities,
    items: client.pickerItems,
    ...client.selection
  });

  const threadId = stringOrNull(client.selection.chat) || stringOrNull(target.threadId);
  if (threadId && !isPlaceholderSelectionID(threadId, "chat")) {
    watchVisibleCodexReplyFromLogs(client, threadId, startedAtMs).catch(error => {
      warnBridge("visible Codex UI reply watch failed", error);
    });
  }

  return {
    ok: true,
    sendMode: "visible-ui",
    text,
    chat: threadId || null,
    project: client.selection.project || target.project || null
  };
}

function stopWatchTranscriptSendMode() {
  const configured = String(
    process.env.CODEX_STOPWATCH_SEND_MODE
      || process.env.CODEX_WATCH_TRANSCRIPT_SEND_MODE
      || ""
  ).trim().toLowerCase();
  if (["app-server", "server", "background"].includes(configured)) {
    return "app-server";
  }
  if (["ui", "visible-ui", "codex-ui", "desktop-ui"].includes(configured)) {
    return "visible-ui";
  }
  if (process.env.CODEX_WATCH_MOCK_APP_SERVER === "1") {
    return "app-server";
  }
  return process.platform === "darwin" ? "visible-ui" : "app-server";
}

function startAudio(client, message) {
  if (client.audioStream) {
    stopAudio(client);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rawPath = path.join(audioDir, `${stamp}.pcm-f32le.raw`);
  const metaPath = path.join(audioDir, `${stamp}.json`);
  fs.writeFileSync(metaPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    sampleRate: message.sampleRate || null,
    channels: message.channels || null,
    encoding: "pcm-f32le"
  }, null, 2));

  client.audioPath = rawPath;
  client.audioBytes = 0;
  client.audioSampleRate = Number(message.sampleRate) || 48000;
  client.audioChannels = Number(message.channels) || 1;
  client.audioStream = fs.createWriteStream(rawPath);
  broadcast({
    type: "state",
    pet: client.pet,
    state: "running",
    title: "Listening",
    body: "Audio streaming",
    capabilities: client.capabilities,
    items: client.pickerItems,
    ...client.selection
  });
}

function appendAudio(client, message) {
  if (!client.audioStream || typeof message.data !== "string") {
    return;
  }
  if (Number(message.sampleRate) > 0) {
    client.audioSampleRate = Number(message.sampleRate);
  }
  if (Number.isInteger(message.channels) && message.channels > 0) {
    client.audioChannels = message.channels;
  }
  const chunk = Buffer.from(message.data, "base64");
  client.audioBytes += chunk.length;
  client.audioStream.write(chunk);
}

function stopAudio(client) {
  if (!client.audioStream) {
    return;
  }
  const stream = client.audioStream;
  const savedPath = client.audioPath;
  const bytes = client.audioBytes;
  const sampleRate = client.audioSampleRate || 48000;
  const channels = client.audioChannels || 1;

  client.audioStream = null;
  client.audioPath = null;
  client.audioBytes = 0;
  client.audioSampleRate = 48000;
  client.audioChannels = 1;
  stream.end(() => {
    sendTranscribingState(client, { bytes, savedPath });
    transcribeSavedAudio(client, { bytes, savedPath, sampleRate, channels }).catch(error => {
      errorBridge("transcription failed", error);
      sendTranscriptionFailure(client, error);
    });
  });
}

function sendTranscribingState(client, { bytes, savedPath }) {
  send(client, {
    type: "state",
    pet: client.pet,
    state: "running",
    title: "Transcribing",
    body: "Processing audio",
    bytes,
    path: savedPath,
    capabilities: client.capabilities,
    items: client.pickerItems,
    ...client.selection
  });
}

async function transcribeSavedAudio(client, { bytes, savedPath, sampleRate, channels }) {
  if (!savedPath || bytes <= 0) {
    throw new Error("No watch audio was received.");
  }

  const wavPath = savedPath.replace(/\.pcm-f32le\.raw$/, ".wav");
  writePCMFloat32Wav(savedPath, wavPath, { sampleRate, channels });
  const text = await transcribeAudio(wavPath);
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Transcription returned no text.");
  }

  send(client, {
    type: "transcript",
    pet: client.pet,
    state: "review",
    title: "Transcript",
    body: trimmed,
    text: trimmed,
    bytes,
    path: wavPath,
    capabilities: client.capabilities,
    items: client.pickerItems,
    ...client.selection
  });
}

function handleTranscriptSend(client, message) {
  const text = String(message.text || message.body || "").trim();
  console.log("transcript-send", `${text.length} chars`);

  if (!text) {
    sendTranscriptSendFailure(client, new Error("Transcript was empty."));
    return;
  }

  const target = resolveTranscriptTarget(client, message);
  if (!target) {
    sendTranscriptSendFailure(client, new Error("Pick a Codex chat before sending."));
    return;
  }

  send(client, {
    type: "state",
    pet: client.pet,
    state: "running",
    title: target.newChat ? "Starting chat" : "Sending",
    body: truncate(text, 140),
    capabilities: client.capabilities,
    items: client.pickerItems,
    ...client.selection
  });

  submitTranscriptToResolvedTarget(client, target, text).catch(error => {
    errorBridge("transcript send failed", error);
    sendTranscriptSendFailure(client, error);
  });
}

async function submitTranscriptToResolvedTarget(client, target, text) {
  let threadId = target.threadId;
  if (target.newChat) {
    threadId = await startNewCodexThread(target.project);
    applyTranscriptTargetSelection(client, target.item, threadId);
    send(client, {
      type: "state",
      pet: client.pet,
      state: "running",
      title: "Sending",
      body: truncate(text, 140),
      capabilities: client.capabilities,
      items: client.pickerItems,
      ...client.selection
    });
  } else {
    applyTranscriptTargetSelection(client, target.item, target.threadId);
  }

  await submitTranscriptToCodex(client, threadId, text);
}

async function startNewCodexThread(projectID) {
  const cwd = cwdFromProjectID(projectID);
  if (!cwd) {
    throw new Error("Pick a Codex project before starting a new chat.");
  }
  if (!fs.existsSync(cwd)) {
    throw new Error(`Project path does not exist: ${cwd}`);
  }

  maybeOpenCodex();
  const response = await getCodexAppServer().request("thread/start", {
    cwd
  }, { timeoutMs: 30000 });
  const threadId = stringOrNull(response?.thread?.id)
    || stringOrNull(response?.threadId)
    || stringOrNull(response?.id);
  if (!threadId) {
    throw new Error("Codex did not return a new chat ID.");
  }
  return threadId;
}

async function submitTranscriptToCodex(client, threadId, text) {
  maybeOpenCodex();
  const appServer = getCodexAppServer();
  const watcher = watchCodexTurn(client, threadId);

  try {
    const resume = await appServer.request("thread/resume", {
      threadId,
      excludeTurns: false,
      persistExtendedHistory: false
    }, { timeoutMs: 30000 });

    const activeTurn = activeTurnFromResume(resume);
    const input = [{
      type: "text",
      text: codexInputTextForTranscript(text),
      text_elements: []
    }];

    if (activeTurn) {
      await appServer.request("turn/steer", {
        threadId,
        input,
        expectedTurnId: activeTurn.id
      }, { timeoutMs: 30000 });
    } else {
      await appServer.request("turn/start", {
        threadId,
        input
      }, { timeoutMs: 30000 });
    }

    if (!watcher.isClosed()) {
      send(client, {
        type: "state",
        pet: client.pet,
        state: "thinking",
        title: "Codex is thinking",
        body: "Working on it",
        capabilities: client.capabilities,
        items: client.pickerItems,
        ...client.selection
      });
    }
  } catch (error) {
    watcher.stop();
    throw error;
  }
}

async function sendTranscriptToCodexDesktopUI(text) {
  if (process.env.CODEX_STOPWATCH_UI_SEND_MOCK === "1") {
    return;
  }
  if (process.platform !== "darwin") {
    throw new Error("Visible Codex UI send is only supported on macOS.");
  }

  maybeOpenCodex();
  const script = `
on run argv
  set messageText to item 1 of argv
  tell application "Codex" to activate
  delay 0.2
  set previousClipboard to missing value
  try
    set previousClipboard to the clipboard
  end try
  set the clipboard to messageText
  delay 0.15
  tell application "System Events"
    tell process "Codex"
      set frontmost to true
    end tell
    keystroke "v" using command down
    delay 0.1
    key code 36
  end tell
  delay 0.2
  if previousClipboard is not missing value then
    set the clipboard to previousClipboard
  end if
end run
`;
  await execFilePromise("/usr/bin/osascript", ["-e", script, text], { timeout: 5000 });
}

async function watchVisibleCodexReplyFromLogs(client, threadId, startedAtMs) {
  const timeoutMs = Number(process.env.CODEX_STOPWATCH_UI_REPLY_TIMEOUT_MS || 180000);
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  const afterMs = Math.max(0, startedAtMs - 1000);

  while (Date.now() < deadline) {
    const reply = latestAssistantTextForThread(threadId, { afterMs, finalOnly: true });
    if (reply) {
      const body = stopWatchReplySummary(reply);
      send(client, {
        type: "state",
        pet: client.pet,
        state: "review",
        title: "Codex replied",
        label: "REPLIED",
        body,
        text: reply,
        event: "completed",
        capabilities: client.capabilities,
        items: client.pickerItems,
        ...client.selection
      });
      return;
    }
    await sleep(1000);
  }
}

function stopWatchReplySummary(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 3);
  return truncate(lines.join("\n") || String(text || "").trim(), 140);
}

function watchCodexTurn(client, threadId) {
  const appServer = getCodexAppServer();
  let turnId = null;
  let responseText = "";
  let lastPreviewMs = 0;
  let isClosed = false;
  const sendTurnState = ({ state, title, body, text }) => {
    send(client, {
      type: "state",
      pet: client.pet,
      state,
      title,
      body,
      text,
      capabilities: client.capabilities,
      items: client.pickerItems,
      ...client.selection
    });
  };

  const cleanupTimer = setTimeout(cleanup, 10 * 60 * 1000);
  cleanupTimer.unref();

  const unsubscribe = appServer.onNotification((method, params = {}) => {
    if (params.threadId !== threadId) {
      return;
    }

    if (method === "turn/started") {
      turnId = params.turn?.id || turnId;
      sendTurnState({
        state: "thinking",
        title: "Codex is thinking",
        body: "Working on it"
      });
      return;
    }

    const desktopState = method !== "item/agentMessage/delta" && method !== "turn/completed"
      ? codexDesktopStateFromNotification(method, params)
      : null;
    if (desktopState) {
      sendTurnState(desktopState);
      return;
    }

    if (method === "item/agentMessage/delta") {
      if (turnId && params.turnId && params.turnId !== turnId) {
        return;
      }
      if (typeof params.delta === "string") {
        responseText = appendAgentDelta(responseText, params.delta);
      }
      const now = Date.now();
      const trimmed = responseText.trim();
      if (trimmed && now - lastPreviewMs > 1500) {
        lastPreviewMs = now;
        sendTurnState({
          state: "running",
          title: "Codex is replying",
          body: truncate(trimmed, 180),
          text: trimmed
        });
      }
      return;
    }

    if (method === "turn/completed") {
      if (turnId && params.turn?.id && params.turn.id !== turnId) {
        return;
      }
      const status = params.turn?.status || "completed";
      if (status === "failed") {
        sendTurnState({
          state: "failed",
          title: "Codex failed",
          body: params.turn?.error?.message || "Open Codex for details"
        });
      } else {
        sendTurnState({
          state: "review",
          title: "Codex replied",
          body: truncate(responseText.trim() || "Open Codex to review", 240),
          text: responseText.trim()
        });
      }
      cleanup();
    }
  });

  function cleanup() {
    if (isClosed) {
      return;
    }
    isClosed = true;
    clearTimeout(cleanupTimer);
    unsubscribe();
  }

  return {
    stop: cleanup,
    isClosed: () => isClosed
  };
}

function codexDesktopStateFromNotification(method, params = {}) {
  const source = params.state
    ?? params.threadRuntimeStatus
    ?? params.runtimeStatus
    ?? params.thread?.status
    ?? params.turn?.status
    ?? params.status;
  const mapped = codexDesktopStateFromStatus(source);
  if (!mapped) {
    return null;
  }

  if (mapped.kind === "approval") {
    return {
      state: "review",
      title: "Approval needed",
      body: params.message || params.body || "Codex is waiting for approval"
    };
  }
  if (mapped.kind === "user-input") {
    return {
      state: "review",
      title: "Input needed",
      body: params.message || params.body || "Codex is waiting for input"
    };
  }

  return {
    state: mapped.state,
    title: params.title || desktopStateTitle(mapped.state, method),
    body: params.body || params.message || desktopStateBody(mapped.state)
  };
}

function codexDesktopStateFromStatus(status) {
  if (!status) {
    return null;
  }

  if (typeof status === "object") {
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    if (flags.includes("waitingOnApproval")) {
      return { state: "review", kind: "approval" };
    }
    if (flags.includes("waitingOnUserInput")) {
      return { state: "review", kind: "user-input" };
    }
    return codexDesktopStateFromStatus(status.type || status.status || status.state);
  }

  switch (normalizeStatus(status)) {
    case "idle":
      return { state: "idle" };
    case "running":
    case "running-left":
    case "running-right":
    case "thinking":
    case "waiting":
    case "review":
    case "failed":
    case "waving":
    case "jumping":
      return { state: normalizeStatus(status) };
    case "active":
    case "inprogress":
    case "in-progress":
    case "loading":
    case "working":
      return { state: "running" };
    case "reasoning":
    case "thinking-started":
    case "thinking-start":
      return { state: "thinking" };
    case "needs-resume":
    case "resuming":
    case "pending":
    case "queued":
      return { state: "waiting" };
    case "approval":
    case "waitingonapproval":
    case "waiting-on-approval":
      return { state: "review", kind: "approval" };
    case "response":
    case "waitingonuserinput":
    case "waiting-on-user-input":
      return { state: "review", kind: "user-input" };
    case "complete":
    case "completed":
    case "done":
    case "success":
    case "succeeded":
      return { state: "review" };
    case "error":
    case "failure":
    case "systemerror":
    case "system-error":
    case "cancelled":
    case "canceled":
      return { state: "failed" };
    default:
      return null;
  }
}

function normalizeStatus(status) {
  return String(status || "")
    .trim()
    .replace(/_/g, "-")
    .toLowerCase();
}

function desktopStateTitle(state, method) {
  switch (state) {
    case "failed":
      return "Codex failed";
    case "review":
      return "Codex replied";
    case "thinking":
      return "Codex is thinking";
    case "waiting":
      return "Codex waiting";
    case "running-left":
    case "running-right":
    case "running":
      return "Codex is working";
    default:
      return method || "Codex";
  }
}

function desktopStateBody(state) {
  switch (state) {
    case "failed":
      return "Open Codex for details";
    case "review":
      return "Open Codex to review";
    case "thinking":
      return "Working on it";
    case "waiting":
      return "Waiting for Codex";
    case "running-left":
    case "running-right":
    case "running":
      return "Working on it";
    default:
      return "Bridge ready";
  }
}

function activeTurnFromResume(resume) {
  const turns = resume?.thread?.turns;
  if (!Array.isArray(turns)) {
    return null;
  }
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.status === "inProgress") {
      return turns[index];
    }
  }
  return null;
}

async function refreshClientStateFromCodex(client) {
  if (client.selection.newChat) {
    return;
  }

  const target = resolveTranscriptTarget(client, {
    project: client.selection.project,
    chat: client.selection.chat,
    target: client.selection.target,
    newChat: false
  });
  if (!target?.threadId) {
    return;
  }

  let resume = null;
  try {
    resume = await getCodexAppServer().request("thread/resume", {
      threadId: target.threadId,
      excludeTurns: false,
      persistExtendedHistory: false
    }, { timeoutMs: 12000 });
  } catch (error) {
    warnBridge("thread/resume state refresh failed", error);
  }

  const activeTurn = activeTurnFromResume(resume);
  if (activeTurn) {
    applyTranscriptTargetSelection(client, target.item, target.threadId);
    send(client, {
      type: "state",
      pet: client.pet,
      state: "thinking",
      title: "Codex is thinking",
      body: "Working on it",
      capabilities: client.capabilities,
      items: client.pickerItems,
      ...client.selection
    });
    return;
  }

  const desktopState = codexDesktopStateFromNotification("thread/status/changed", {
    threadId: target.threadId,
    thread: resume?.thread,
    threadRuntimeStatus: resume?.thread?.status
  });
  if (desktopState && desktopState.state !== "idle" && desktopState.state !== "review") {
    applyTranscriptTargetSelection(client, target.item, target.threadId);
    send(client, {
      type: "state",
      pet: client.pet,
      ...desktopState,
      capabilities: client.capabilities,
      items: client.pickerItems,
      ...client.selection
    });
    return;
  }

  const replyText = latestAssistantTextFromResume(resume) || latestAssistantTextForThread(target.threadId);
  if (!replyText) {
    return;
  }

  applyTranscriptTargetSelection(client, target.item, target.threadId);
  const message = {
    type: "state",
    pet: client.pet,
    state: "review",
    title: "Codex replied",
    body: truncate(replyText, 240),
    text: replyText,
    capabilities: client.capabilities,
    items: client.pickerItems,
    ...client.selection
  };
  if (readStateSignaturesBySelection.get(selectionKey(message)) === durableStateSignature(message)) {
    return;
  }
  send(client, message);
}

function resolveTranscriptTarget(client, message) {
  if (!Array.isArray(client.pickerItems) || client.pickerItems.length === 0) {
    client.pickerItems = loadCodexPickerItems();
  }

  const explicitChat = stringOrNull(message.chat) || stringOrNull(client.selection.chat);
  const project = stringOrNull(message.project) || stringOrNull(client.selection.project);
  const wantsNewChat = message.newChat === true
    || client.selection.newChat === true
    || message.action === "new-chat"
    || isNewChatSelectionID(explicitChat);
  const chatItems = client.pickerItems.filter(item => stringOrNull(item.chat));
  if (wantsNewChat) {
    return {
      newChat: true,
      project,
      item: project
        ? client.pickerItems.find(item => item.kind === "project" && item.project === project) || null
        : null,
      threadId: null
    };
  }
  const exact = explicitChat
    ? chatItems.find(item => item.chat === explicitChat)
    : null;
  if (exact) {
    return { threadId: exact.chat, item: exact };
  }
  if (explicitChat && !isPlaceholderSelectionID(explicitChat, "chat")) {
    return { threadId: explicitChat, item: null };
  }

  const projectChat = project
    ? chatItems.find(item => item.project === project)
    : null;
  if (projectChat) {
    return { threadId: projectChat.chat, item: projectChat };
  }

  if (chatItems.length > 0) {
    return { threadId: chatItems[0].chat, item: chatItems[0] };
  }

  return null;
}

function applyTranscriptTargetSelection(client, item, threadId) {
  client.selection.target = "chat";
  client.selection.chat = threadId;
  client.selection.newChat = false;
  if (item?.project) {
    client.selection.project = item.project;
  }
  if (Number.isInteger(item?.projectIndex)) {
    client.selection.projectIndex = item.projectIndex;
  }
  if (Number.isInteger(item?.chatIndex)) {
    client.selection.chatIndex = item.chatIndex;
  }
}

function isPlaceholderSelectionID(value, prefix) {
  return new RegExp(`^${prefix}-\\d+$`).test(value);
}

function isNewChatSelectionID(value) {
  return typeof value === "string" && value.startsWith("new-chat:");
}

function latestAssistantTextFromResume(resume) {
  const turns = resume?.thread?.turns;
  if (!Array.isArray(turns)) {
    return "";
  }
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const items = Array.isArray(turns[turnIndex]?.items) ? turns[turnIndex].items : [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const text = assistantTextFromObject(items[itemIndex]);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function latestAssistantTextForThread(threadId, { afterMs = 0, finalOnly = false } = {}) {
  const file = sessionFileForThread(threadId);
  if (!file) {
    return "";
  }

  let finalAnswer = "";
  let latestAgentMessage = "";
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (afterMs > 0) {
      const eventMs = Date.parse(event.timestamp || "");
      if (!Number.isFinite(eventMs) || eventMs < afterMs) {
        continue;
      }
    }

    const responseText = assistantTextFromObject(event.payload);
    if (responseText) {
      if (event.payload?.phase === "final_answer") {
        finalAnswer = responseText;
      }
      latestAgentMessage = responseText;
    }
    if (event.payload?.type === "agent_message" && typeof event.payload.message === "string") {
      if (event.payload.phase === "final_answer") {
        finalAnswer = event.payload.message.trim();
      }
      latestAgentMessage = event.payload.message.trim();
    }
  }

  return finalOnly ? finalAnswer : finalAnswer || latestAgentMessage;
}

function assistantTextFromObject(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  if (value.role === "assistant" && typeof value.message === "string") {
    return value.message.trim();
  }
  if (value.role === "assistant" && typeof value.text === "string") {
    return value.text.trim();
  }
  if (value.role === "assistant" && Array.isArray(value.content)) {
    return value.content
      .map(part => typeof part?.text === "string" ? part.text : "")
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if ((value.type === "agent_message" || value.type === "message")
    && typeof value.message === "string"
    && value.role !== "user") {
    return value.message.trim();
  }
  return "";
}

function sessionFileForThread(threadId) {
  if (!threadId) {
    return null;
  }
  const files = findSessionFiles(currentCodexSessionsDir());
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n").slice(0, 20);
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "session_meta" && event.payload?.id === threadId) {
        return file;
      }
    }
  }
  return null;
}

function cwdFromProjectID(projectID) {
  if (typeof projectID !== "string" || !projectID.startsWith("project:")) {
    return null;
  }
  const cwd = projectID.slice("project:".length);
  return path.isAbsolute(cwd) ? cwd : null;
}

function sendTranscriptSendFailure(client, error) {
  send(client, {
    type: "state",
    pet: client.pet,
    state: "failed",
    title: "Send failed",
    body: error.message,
    capabilities: client.capabilities,
    items: client.pickerItems,
    ...client.selection
  });
}

async function transcribeAudio(wavPath) {
  const provider = currentTranscriptionProvider();
  if (provider === "mock") {
    return process.env.CODEX_WATCH_MOCK_TRANSCRIPT || "Mock transcript from watch audio.";
  }

  const errors = [];
  if (provider !== "openai") {
    try {
      return await transcribeWithCodexDesktop(wavPath);
    } catch (error) {
      errors.push(`Codex desktop transcription failed: ${error.message}`);
      if (provider !== "auto") {
        throw new Error(errors[0]);
      }
    }
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      return await transcribeWithOpenAI(wavPath);
    } catch (error) {
      errors.push(`OpenAI transcription failed: ${error.message}`);
    }
  } else if (provider === "openai") {
    errors.push("OPENAI_API_KEY is not set.");
  }

  throw new Error(errors.join(" "));
}

async function transcribeWithCodexDesktop(wavPath) {
  const audio = await fs.promises.readFile(wavPath);
  const { body, boundary } = createMultipartBody({
    file: {
      name: "file",
      filename: path.basename(wavPath),
      contentType: "audio/wav",
      data: audio
    }
  });

  return transcribeWithCodexDesktopBody(body, boundary, { refreshToken: false });
}

async function transcribeWithCodexDesktopBody(body, boundary, { refreshToken }) {
  const token = await getCodexAppServer().getAuthToken({ refreshToken });
  if (!token) {
    throw new Error("Codex is not signed in with ChatGPT auth.");
  }

  const headers = codexDesktopHeaders(token, {
    "content-type": `multipart/form-data; boundary=${boundary}`
  });
  const response = await fetchWithTimeout(`${codexAPIBaseURL}/transcribe`, {
    method: "POST",
    headers,
    body
  }, { timeoutMs: 30000 });
  if (response.status === 401 && !refreshToken) {
    return transcribeWithCodexDesktopBody(body, boundary, { refreshToken: true });
  }

  const text = await response.text();
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch {}
  if (!response.ok) {
    throw new Error(errorMessageFromCodexResponse(response, payload, text));
  }
  return typeof payload.text === "string" ? payload.text : "";
}

async function transcribeWithOpenAI(wavPath) {
  const audio = await fs.promises.readFile(wavPath);
  const form = new FormData();
  form.append("model", process.env.CODEX_WATCH_TRANSCRIBE_MODEL || defaultTranscriptionModel);
  form.append("file", new Blob([audio], { type: "audio/wav" }), path.basename(wavPath));

  const response = await fetchWithTimeout("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: form
  }, { timeoutMs: 30000 });
  const body = await response.text();
  let payload = {};
  try {
    payload = JSON.parse(body);
  } catch {}
  if (!response.ok) {
    throw new Error(payload.error?.message || body || `Transcription failed with ${response.status}`);
  }
  return typeof payload.text === "string" ? payload.text : "";
}

function getCodexAppServer() {
  if (process.env.CODEX_WATCH_MOCK_APP_SERVER === "1") {
    codexAppServer ??= new MockCodexAppServerClient();
    return codexAppServer;
  }

  codexAppServer ??= new CodexAppServerClient();
  return codexAppServer;
}

class MockCodexAppServerClient {
  notificationHandlers = new Set();

  async getAuthToken() {
    return "mock-token";
  }

  async request(method, params = {}) {
    switch (method) {
      case "thread/resume":
        if (process.env.CODEX_WATCH_MOCK_RESUME_STATE === "thinking") {
          return {
            thread: {
              id: params.threadId,
              status: { type: "active" },
              turns: [{ id: "mock-active-turn", status: "inProgress", items: [] }]
            }
          };
        }
        if (process.env.CODEX_WATCH_MOCK_RESUME_REPLY) {
          return {
            thread: {
              id: params.threadId,
              status: { type: "idle" },
              turns: [{
                id: "mock-completed-turn",
                status: "completed",
                items: [{
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: process.env.CODEX_WATCH_MOCK_RESUME_REPLY }]
                }]
              }]
            }
          };
        }
        return {
          thread: {
            id: params.threadId,
            status: { type: "idle" },
            turns: []
          }
        };
      case "thread/start": {
        const threadId = `mock-new-thread-${Date.now()}`;
        queueMicrotask(() => {
          this.emitNotification("thread/started", {
            thread: { id: threadId, cwd: params.cwd, status: { type: "idle" } }
          });
        });
        return {
          thread: {
            id: threadId,
            cwd: params.cwd,
            status: { type: "idle" }
          }
        };
      }
      case "turn/start":
      case "turn/steer": {
        const turnId = `mock-turn-${Date.now()}`;
        const threadId = params.threadId;
        queueMicrotask(() => {
          this.emitNotification("turn/started", {
            threadId,
            turn: { id: turnId, status: "inProgress", items: [] }
          });
          const activeFlag = process.env.CODEX_WATCH_MOCK_ACTIVE_FLAG;
          if (activeFlag) {
            this.emitNotification("thread/status", {
              threadId,
              threadRuntimeStatus: {
                type: "active",
                activeFlags: [activeFlag]
              }
            });
          }
          for (const delta of mockReplyDeltas()) {
            this.emitNotification("item/agentMessage/delta", {
              threadId,
              turnId,
              itemId: "mock-agent-message",
              delta
            });
          }
          this.emitNotification("turn/completed", {
            threadId,
            turn: { id: turnId, status: "completed", items: [] }
          });
        });
        return {};
      }
      case "account/rateLimits/read":
        if (process.env.CODEX_WATCH_MOCK_RATE_LIMITS_JSON) {
          return JSON.parse(process.env.CODEX_WATCH_MOCK_RATE_LIMITS_JSON);
        }
        return {};
      default:
        return {};
    }
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  emitNotification(method, params) {
    for (const handler of this.notificationHandlers) {
      handler(method, params);
    }
  }
}

function appendAgentDelta(current, delta) {
  if (!delta) {
    return current;
  }
  if (!current) {
    return delta;
  }
  if (shouldInsertBoundarySpace(current, delta)) {
    return `${current} ${delta}`;
  }
  return current + delta;
}

function shouldInsertBoundarySpace(current, delta) {
  const last = current[current.length - 1];
  const first = delta[0];
  if (!last || !first || /\s/.test(last) || /\s/.test(first)) {
    return false;
  }
  return /[.!?]/.test(last) && /[A-Z"`'“‘(\[]/.test(first);
}

function mockReplyDeltas() {
  const rawChunks = process.env.CODEX_WATCH_MOCK_REPLY_CHUNKS;
  if (rawChunks) {
    try {
      const chunks = JSON.parse(rawChunks);
      if (Array.isArray(chunks)) {
        return chunks.map(String);
      }
    } catch {
      return rawChunks.split("|");
    }
  }
  return [process.env.CODEX_WATCH_MOCK_REPLY || "Mock **reply** with `inlineCode`."];
}

class CodexAppServerClient {
  proc = null;
  readyPromise = null;
  stdoutBuffer = "";
  nextRequestID = 1;
  pending = new Map();
  notificationHandlers = new Set();

  async getAuthToken({ refreshToken }) {
    const status = await this.request("getAuthStatus", {
      includeToken: true,
      refreshToken
    });
    return typeof status?.authToken === "string" && status.authToken.length > 0
      ? status.authToken
      : null;
  }

  async request(method, params = {}, { timeoutMs = 20000 } = {}) {
    await this.ensureReady();
    return this.sendRequest(method, params, { timeoutMs });
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  async ensureReady() {
    if (this.proc && this.readyPromise) {
      return this.readyPromise;
    }
    this.startProcess();
    this.readyPromise = this.sendRequest("initialize", {
      clientInfo: {
        name: "codex-watch-bridge",
        title: "Codex Watch Bridge",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    }, { timeoutMs: 20000 }).catch(error => {
      this.dispose();
      throw error;
    });
    return this.readyPromise;
  }

  startProcess() {
    const executable = resolveCodexCLIPath();
    if (!executable) {
      throw new Error("Unable to locate the Codex CLI/app-server binary.");
    }

    this.proc = spawn(executable, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        LOG_FORMAT: "json",
        RUST_LOG: process.env.RUST_LOG || "warn",
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Watch Bridge"
      }
    });
    this.stdoutBuffer = "";
    this.proc.stdout.on("data", chunk => this.handleStdout(chunk));
    this.proc.stderr.on("data", chunk => this.handleStderr(chunk));
    this.proc.on("exit", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      this.rejectPending(new Error(`Codex app-server exited with ${reason}.`));
      this.proc = null;
      this.readyPromise = null;
    });
    this.proc.on("error", error => {
      this.rejectPending(error);
      this.proc = null;
      this.readyPromise = null;
    });
  }

  sendRequest(method, params, { timeoutMs }) {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) {
      throw new Error("Codex app-server is not running.");
    }

    const id = this.nextRequestID++;
    const message = { id, method, params };
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Codex app-server ${method}.`));
      }, timeoutMs);
      timeout.unref();
      this.pending.set(id, { resolve, reject, timeout });
    });
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk.toString("utf8");
    let newlineIndex;
    while ((newlineIndex = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.handleMessageLine(line);
      }
    }
  }

  handleMessageLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      warnBridge("codex app-server emitted non-json output", new Error(line.slice(0, 160)));
      return;
    }

    if ("id" in message && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === "string" && !("id" in message)) {
      this.emitNotification(message.method, message.params || {});
      return;
    }

    if ("id" in message && typeof message.method === "string") {
      this.respondToServerRequest(message.id, {
        code: -32601,
        message: `Unsupported server request: ${message.method}`
      });
    }
  }

  emitNotification(method, params) {
    for (const handler of this.notificationHandlers) {
      try {
        handler(method, params);
      } catch (error) {
        warnBridge("codex app-server notification handler failed", error);
      }
    }
  }

  respondToServerRequest(id, error) {
    try {
      this.proc?.stdin?.write(`${JSON.stringify({ id, error })}\n`);
    } catch {}
  }

  handleStderr(chunk) {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const payload = JSON.parse(trimmed);
        const level = String(payload.level || "").toUpperCase();
        if (level === "ERROR") {
          errorBridge("codex app-server error", new Error(payload.fields?.message || trimmed));
        }
      } catch {
        warnBridge("codex app-server warning", new Error(trimmed));
      }
    }
  }

  rejectPending(error) {
    for (const { reject, timeout } of this.pending.values()) {
      clearTimeout(timeout);
      reject(error);
    }
    this.pending.clear();
  }

  dispose() {
    if (this.proc && !this.proc.killed) {
      this.proc.kill();
    }
    this.rejectPending(new Error("Codex app-server connection disposed."));
    this.proc = null;
    this.readyPromise = null;
    this.stdoutBuffer = "";
  }
}

function resolveCodexCLIPath() {
  const candidates = [
    process.env.CODEX_CLI_PATH,
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex"
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  try {
    const found = execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
    return found.length > 0 ? found : null;
  } catch {
    return null;
  }
}

function createMultipartBody({ file, fields = {} }) {
  const boundary = `----codex-watch-${crypto.randomUUID()}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${escapeMultipartValue(name)}"\r\n\r\n`));
    chunks.push(Buffer.from(String(value)));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}\r\n`));
  chunks.push(Buffer.from(
    `Content-Disposition: form-data; name="${escapeMultipartValue(file.name)}"; filename="${escapeMultipartValue(file.filename)}"\r\n`
  ));
  chunks.push(Buffer.from(`Content-Type: ${file.contentType}\r\n\r\n`));
  chunks.push(file.data);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), boundary };
}

function escapeMultipartValue(value) {
  return String(value).replaceAll('"', "");
}

function codexDesktopHeaders(token, headers = {}) {
  const merged = {
    ...headers,
    authorization: `Bearer ${token}`,
    originator: "Codex Desktop",
    "user-agent": codexDesktopUserAgent()
  };
  const accountID = chatGPTAccountIDFromToken(token);
  if (accountID) {
    merged["chatgpt-account-id"] = accountID;
  }
  return merged;
}

let codexDesktopVersionCache = null;
function codexDesktopUserAgent() {
  codexDesktopVersionCache ??= readCodexDesktopVersion();
  const platform = process.platform === "darwin"
    ? "Macintosh; Intel Mac OS X"
    : process.platform;
  return `Codex Desktop/${codexDesktopVersionCache} (${platform}; ${process.arch})`;
}

function readCodexDesktopVersion() {
  try {
    return execFileSync("defaults", [
      "read",
      "/Applications/Codex.app/Contents/Info",
      "CFBundleShortVersionString"
    ], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function chatGPTAccountIDFromToken(token) {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const auth = parsed["https://api.openai.com/auth"];
    return typeof auth?.chatgpt_account_id === "string"
      ? auth.chatgpt_account_id
      : null;
  } catch {
    return null;
  }
}

function errorMessageFromCodexResponse(response, payload, body) {
  if (typeof payload.detail === "string") {
    return payload.detail;
  }
  if (typeof payload.error === "string") {
    return payload.error;
  }
  if (typeof payload.error?.message === "string") {
    return payload.error.message;
  }
  return body || `Codex transcription failed with ${response.status}`;
}

async function fetchWithTimeout(url, options = {}, { timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sendTranscriptionFailure(client, error) {
  send(client, {
    type: "state",
    pet: client.pet,
    state: "failed",
    title: "Transcription unavailable",
    body: error.message,
    capabilities: client.capabilities,
    items: client.pickerItems,
    ...client.selection
  });
}

function writePCMFloat32Wav(rawPath, wavPath, { sampleRate, channels }) {
  const raw = fs.readFileSync(rawPath);
  const samples = Math.floor(raw.length / 4);
  const pcm = Buffer.alloc(samples * 2);

  for (let index = 0; index < samples; index += 1) {
    const sample = Math.max(-1, Math.min(1, raw.readFloatLE(index * 4)));
    const value = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    pcm.writeInt16LE(Math.round(value), index * 2);
  }

  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  fs.writeFileSync(wavPath, Buffer.concat([header, pcm]));
}

function writePCM16Wav(rawPath, wavPath, { sampleRate, channels }) {
  const raw = fs.readFileSync(rawPath);
  const usableBytes = raw.length - (raw.length % 2);
  const pcm = usableBytes === raw.length ? raw : raw.subarray(0, usableBytes);
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  fs.writeFileSync(wavPath, Buffer.concat([header, pcm]));
}

function positiveHeaderInteger(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function handleSelection(client, message) {
  updateClientSelection(client, message);
  logVerbose(
    message.type,
    client.selection.target,
    `project=${redactedSelectionID(client.selection.project)}`,
    `chat=${redactedSelectionID(client.selection.chat)}`,
    client.selection.newChat ? "new-chat" : "existing-chat",
    typeof message.delta === "number" ? `delta=${message.delta}` : "focus"
  );
  broadcast({
    type: "selection",
    pet: client.pet,
    state: message.state || "idle",
    body: "Digital Crown",
    capabilities: client.capabilities,
    items: client.pickerItems,
    action: message.action || null,
    delta: Number.isFinite(message.delta) ? message.delta : null,
    index: Number.isFinite(message.index) ? message.index : null,
    ...client.selection
  });
}

function updateClientPickerItems(client, message) {
  if (Array.isArray(message.items)) {
    client.pickerItems = normalizePickerItems(message.items);
  }
}

function normalizePickerItems(items) {
  return items
    .filter(item => item && typeof item === "object")
    .map((item, index) => {
      const project = stringOrNull(item.project);
      const chat = stringOrNull(item.chat);
      const id = stringOrNull(item.id) || chat || project || `picker-item-${index}`;
      return {
        id,
        title: stringOrNull(item.title) || id,
        subtitle: stringOrNull(item.subtitle),
        kind: stringOrNull(item.kind),
        section: stringOrNull(item.section),
        project,
        chat,
        projectIndex: integerOrNull(item.projectIndex),
        chatIndex: integerOrNull(item.chatIndex),
        unread: typeof item.unread === "boolean" ? item.unread : null,
        pinned: typeof item.pinned === "boolean" ? item.pinned : null
      };
    });
}

function loadCodexPickerItems() {
  try {
    const sessionFiles = findSessionFiles(currentCodexSessionsDir())
      .map(file => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, Number(process.env.CODEX_WATCH_MAX_SESSIONS || 500));
    const sessions = sessionFiles
      .map(({ file, mtimeMs }) => readSessionSummary(file, mtimeMs))
      .filter(Boolean);
    return buildPickerItems(sessions);
  } catch (error) {
    warnBridge("failed to load Codex sessions", error);
    return fallbackPickerItems();
  }
}

function currentCodexSessionsDir() {
  if (process.env.CODEX_SESSIONS_DIR) {
    return process.env.CODEX_SESSIONS_DIR;
  }
  if (process.env.CODEX_HOME) {
    return path.join(process.env.CODEX_HOME, "sessions");
  }
  return defaultCodexSessionsDir;
}

function currentCodexSessionRoots() {
  const sessionsDir = currentCodexSessionsDir();
  const roots = [sessionsDir];
  if (path.basename(sessionsDir) === "sessions") {
    roots.push(path.join(path.dirname(sessionsDir), "archived_sessions"));
  }
  return [...new Set(roots)];
}

function findSessionFilesInRoots(roots) {
  const seen = new Set();
  const files = [];
  for (const root of roots) {
    for (const file of findSessionFiles(root)) {
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      files.push(file);
    }
  }
  return files;
}

function currentTranscriptionProvider() {
  return process.env.CODEX_WATCH_TRANSCRIBE_PROVIDER || "auto";
}

function findSessionFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...findSessionFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(entryPath);
    }
  }
  return files;
}

function readSessionSummary(file, mtimeMs) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  let meta = null;
  const userTexts = [];
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "session_meta") {
      meta = event.payload;
      continue;
    }
    const text = userTextFromEvent(event);
    if (text) {
      userTexts.push(text);
    }
  }
  if (!meta?.id || !meta?.cwd) {
    return null;
  }
  return {
    id: meta.id,
    cwd: meta.cwd,
    timestamp: meta.timestamp || new Date(mtimeMs).toISOString(),
    title: summarizePrompt(userTexts) || shortSessionID(meta.id),
    source: meta.source || null,
    file,
    mtimeMs
  };
}

function userTextFromEvent(event) {
  const payload = event.payload || {};
  if (payload.role !== "user" && payload.type !== "user_message") {
    return null;
  }
  if (typeof payload.message === "string") {
    return cleanPromptText(payload.message);
  }
  if (Array.isArray(payload.content)) {
    const text = payload.content
      .map(part => typeof part?.text === "string" ? part.text : "")
      .filter(Boolean)
      .join("\n");
    return cleanPromptText(text);
  }
  return null;
}

function cleanPromptText(text) {
  const withoutContext = text
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "")
    .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/g, "")
    .replace(/<apps_instructions>[\s\S]*?<\/apps_instructions>/g, "")
    .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/g, "")
    .replace(/<plugins_instructions>[\s\S]*?<\/plugins_instructions>/g, "");
  const lines = withoutContext
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !line.startsWith("# AGENTS.md instructions"))
    .filter(line => !line.startsWith("<INSTRUCTIONS>"))
    .filter(line => !line.startsWith("</INSTRUCTIONS>"));
  const natural = lines.find(line => !line.startsWith("/") && !line.startsWith("<"));
  return natural || lines[0] || "";
}

function summarizePrompt(texts) {
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const text = texts[index]
      .replace(/\s+/g, " ")
      .trim();
    if (text.length > 0) {
      return truncate(text, 56);
    }
  }
  return "";
}

function buildPickerItems(sessions) {
  const projectMap = new Map();
  for (const session of sessions) {
    const projectID = projectIDForPath(session.cwd);
    if (!projectMap.has(projectID)) {
      projectMap.set(projectID, {
        id: projectID,
        cwd: session.cwd,
        latestMs: session.mtimeMs,
        sessions: []
      });
    }
    const project = projectMap.get(projectID);
    project.latestMs = Math.max(project.latestMs, session.mtimeMs);
    project.sessions.push(session);
  }

  const projects = [...projectMap.values()]
    .sort((left, right) => right.latestMs - left.latestMs)
    .slice(0, Number(process.env.CODEX_WATCH_MAX_PROJECTS || 80));
  const items = [];
  projects.forEach((project, projectIndex) => {
    const sortedSessions = project.sessions
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, Number(process.env.CODEX_WATCH_MAX_CHATS_PER_PROJECT || 80));
    items.push({
      id: project.id,
      title: projectTitle(project.cwd),
      subtitle: compactPath(project.cwd),
      kind: "project",
      section: "projects",
      project: project.id,
      projectIndex
    });
    sortedSessions.forEach((session, chatIndex) => {
      items.push({
        id: session.id,
        title: session.title,
        subtitle: relativeTimeLabel(session.mtimeMs),
        kind: "chat",
        section: "chats",
        project: project.id,
        chat: session.id,
        projectIndex,
        chatIndex
      });
    });
  });

  return items.length > 0 ? items : fallbackPickerItems();
}

function fallbackPickerItems() {
  const cwd = process.cwd();
  const project = projectIDForPath(cwd);
  return [
    {
      id: project,
      title: projectTitle(cwd),
      subtitle: compactPath(cwd),
      kind: "project",
      section: "projects",
      project,
      projectIndex: 0
    }
  ];
}

function projectIDForPath(value) {
  return `project:${value}`;
}

function projectTitle(value) {
  return path.basename(value) || value;
}

function compactPath(value) {
  const home = os.homedir();
  if (value === home) {
    return "~";
  }
  if (value.startsWith(`${home}${path.sep}`)) {
    return `~/${value.slice(home.length + 1)}`;
  }
  return value;
}

function shortSessionID(value) {
  return value.split("-").at(-1) || value;
}

function truncate(value, maxLength) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function relativeTimeLabel(mtimeMs) {
  const deltaSeconds = Math.max(0, Math.round((Date.now() - mtimeMs) / 1000));
  if (deltaSeconds < 60) {
    return "Just now";
  }
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h ago`;
  }
  const deltaDays = Math.round(deltaHours / 24);
  if (deltaDays < 14) {
    return `${deltaDays}d ago`;
  }
  return new Date(mtimeMs).toLocaleDateString();
}

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function updateClientSelection(client, message) {
  if (typeof message.target === "string" && ["project", "chat"].includes(message.target)) {
    client.selection.target = message.target;
  }
  if (typeof message.project === "string" && message.project.length > 0) {
    client.selection.project = message.project;
  }
  if (typeof message.chat === "string" && message.chat.length > 0) {
    client.selection.chat = message.chat;
  }
  if (message.newChat === true || message.action === "new-chat" || isNewChatSelectionID(message.chat)) {
    client.selection.newChat = true;
  } else if (message.newChat === false || (typeof message.chat === "string" && !isNewChatSelectionID(message.chat))) {
    client.selection.newChat = false;
  }
  if (Number.isInteger(message.projectIndex)) {
    client.selection.projectIndex = message.projectIndex;
  }
  if (Number.isInteger(message.chatIndex)) {
    client.selection.chatIndex = message.chatIndex;
  }
}

function rememberDurableState(message) {
  if (!message || message.type !== "state") {
    return;
  }
  const observedAt = typeof message.observedAt === "string" && message.observedAt.length > 0
    ? message.observedAt
    : new Date().toISOString();
  latestBridgeState = {
    ...message,
    observedAt,
    capabilities: undefined,
    items: undefined
  };
  const state = normalizeStatus(message.state);
  if (!isDurableWatchState(state)) {
    return;
  }

  const durableState = {
    ...message,
    state,
    observedAt,
    capabilities: undefined,
    items: undefined
  };
  const key = selectionKey(durableState);
  const signature = durableStateSignature(durableState);
  if (readStateSignaturesBySelection.get(key) === signature) {
    return;
  }
  durableStateBySelection.set(key, durableState);
  readStateSignaturesBySelection.delete(key);
  latestDurableState = durableState;
}

async function buildStopWatchSnapshot(server) {
  syncStopWatchDesktopStateFromSessions();
  const stateMessage = stopWatchStateMessage();
  const state = normalizeStatus(stateMessage.state) || "idle";
  return {
    ok: true,
    type: "stopwatch-state",
    device: "m5stack-stopwatch",
    state,
    label: stopWatchStateLabel(state, stateMessage),
    title: stateMessage.title || "Codex",
    body: stopWatchCompactText(stateMessage.body || "Bridge ready", state),
    text: stopWatchCompactText(stateMessage.text || "", state),
    event: stopWatchEventForState(state, stateMessage),
    observedAt: stateMessage.observedAt || null,
    recent: stopWatchRecentForState(stateMessage),
    usage: await codexUsageSnapshot(stateMessage),
    bridge: {
      linked: true,
      clients: clients.size,
      port: boundPort(server),
      tokenRequired: Boolean(currentPairingToken()),
      updatedAt: new Date().toISOString()
    },
    selection: {
      project: stateMessage.project || null,
      chat: stateMessage.chat || null,
      projectIndex: integerOrNull(stateMessage.projectIndex),
      chatIndex: integerOrNull(stateMessage.chatIndex)
    }
  };
}

function stopWatchRecentForState(message = {}) {
  return {
    activity: typeof message.activity === "string" ? message.activity : "",
    user: typeof message.lastUser === "string" ? stopWatchCompactText(message.lastUser, "waiting") : "",
    reply: typeof message.lastReply === "string"
      ? stopWatchReplySummary(message.lastReply)
      : stopWatchCompactText(typeof message.text === "string" ? message.text : "", "review")
  };
}

function stopWatchCompactText(text, state = "") {
  const raw = String(text || "").trim();
  if (!raw) {
    return "";
  }
  if (state === "review") {
    return stopWatchReplySummary(raw);
  }
  return truncate(raw.replace(/\s+/g, " "), 140);
}

function syncStopWatchDesktopStateFromSessions() {
  const desktopState = latestStopWatchDesktopStateFromSessions();
  if (!desktopState) {
    return;
  }

  const currentMs = stateObservedMs(latestBridgeState);
  const desktopMs = stateObservedMs(desktopState);
  if (desktopMs <= 0) {
    return;
  }
  if (currentMs > 0 && desktopMs > 0 && desktopMs <= currentMs) {
    return;
  }
  rememberDurableState(desktopState);
}

function stateObservedMs(message = {}) {
  const parsed = Date.parse(message?.observedAt || message?.updatedAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestStopWatchDesktopStateFromSessions() {
  const files = findSessionFilesInRoots(currentCodexSessionRoots())
    .map(file => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const limit = Number(process.env.CODEX_STOPWATCH_DESKTOP_SYNC_SCAN_LIMIT || 20);
  const pickerItems = loadCodexPickerItems();

  for (const { file, mtimeMs } of files.slice(0, limit)) {
    const state = stopWatchDesktopStateFromSessionFile(file, mtimeMs, pickerItems);
    if (state) {
      return state;
    }
  }
  return null;
}

function stopWatchDesktopStateFromSessionFile(file, mtimeMs, pickerItems = []) {
  const lines = readSessionHeadTailLines(file);
  let meta = null;
  let lastUser = "";
  let lastReply = "";
  let lastReplyAt = "";
  let activeTurn = null;

  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "session_meta") {
      meta = event.payload;
      continue;
    }

    const eventAt = typeof event.timestamp === "string" ? event.timestamp : "";
    const userText = userTextFromEvent(event);
    if (userText) {
      lastUser = userText;
    }

    if (event.type === "event_msg" && event.payload?.type === "task_started") {
      activeTurn = {
        id: event.payload.turn_id || event.payload.turnId || "",
        startedAt: eventAt,
        observedAt: eventAt,
        lastKind: "user",
        lastBody: lastUser,
        finalAnswer: ""
      };
      continue;
    }

    const finalText = finalAnswerTextFromEvent(event);
    if (finalText) {
      lastReply = finalText;
      lastReplyAt = eventAt;
      if (activeTurn) {
        activeTurn.finalAnswer = finalText;
      }
    }

    const payload = event.payload || {};
    const payloadType = payload.type || "";
    const responseItemType = event.type === "response_item" ? payload.type : "";
    if (!activeTurn
      && eventAt
      && (userText || responseItemType === "reasoning" || responseItemType === "function_call"
        || responseItemType === "function_call_output" || payloadType === "agent_message")) {
      activeTurn = {
        id: "",
        startedAt: eventAt,
        observedAt: eventAt,
        lastKind: "thinking",
        lastBody: lastUser,
        finalAnswer: ""
      };
    }
    if (!activeTurn) {
      continue;
    }
    if (eventAt) {
      activeTurn.observedAt = eventAt;
    }
    if (userText) {
      activeTurn.lastKind = "user";
      activeTurn.lastBody = userText;
      continue;
    }
    if (event.type === "event_msg" && payloadType === "agent_message" && payload.phase === "commentary") {
      activeTurn.lastKind = "commentary";
      activeTurn.lastBody = payload.message || "";
      continue;
    }
    if (event.type === "response_item" && responseItemType === "function_call") {
      activeTurn.lastKind = "command";
      activeTurn.lastBody = payload.name || "command";
      continue;
    }
    if (event.type === "response_item" && responseItemType === "function_call_output") {
      activeTurn.lastKind = "command";
      activeTurn.lastBody = "Command output";
      continue;
    }
    if (event.type === "response_item" && responseItemType === "reasoning") {
      activeTurn.lastKind = "thinking";
      activeTurn.lastBody = lastUser;
      continue;
    }
    if (event.type === "event_msg" && payloadType === "task_complete") {
      const reply = String(payload.last_agent_message || activeTurn.finalAnswer || lastReply || "").trim();
      if (reply) {
        lastReply = reply;
        lastReplyAt = eventAt;
      }
      activeTurn.completed = true;
    }
  }

  if (!meta?.id || !meta?.cwd) {
    return null;
  }

  const project = projectIDForPath(meta.cwd);
  const pickerItem = pickerItems.find(item => item.chat === meta.id);
  if (activeTurn && !activeTurn.completed) {
    return stopWatchActiveDesktopTurnState({
      meta,
      project,
      pickerItem,
      turn: activeTurn,
      lastUser,
      lastReply
    });
  }

  if (!lastReply) {
    return null;
  }

  return {
    type: "state",
    pet: "kurisu",
    state: "review",
    title: "Codex replied",
    label: "REPLIED",
    body: stopWatchReplySummary(lastReply),
    text: lastReply,
    event: "completed",
    activity: "desktop-replied",
    lastUser,
    lastReply,
    observedAt: lastReplyAt || new Date(mtimeMs).toISOString(),
    project,
    chat: meta.id,
    projectIndex: integerOrNull(pickerItem?.projectIndex),
    chatIndex: integerOrNull(pickerItem?.chatIndex)
  };
}

function readSessionHeadTailLines(file) {
  const stat = fs.statSync(file);
  const maxFullBytes = Number(process.env.CODEX_STOPWATCH_DESKTOP_SYNC_FULL_READ_BYTES || 512 * 1024);
  if (stat.size <= maxFullBytes) {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  }

  const headBytes = Number(process.env.CODEX_STOPWATCH_DESKTOP_SYNC_HEAD_BYTES || 32 * 1024);
  const tailBytes = Number(process.env.CODEX_STOPWATCH_DESKTOP_SYNC_TAIL_BYTES || 256 * 1024);
  const fd = fs.openSync(file, "r");
  try {
    const headBuffer = Buffer.alloc(Math.min(headBytes, stat.size));
    fs.readSync(fd, headBuffer, 0, headBuffer.length, 0);

    const tailLength = Math.min(tailBytes, stat.size);
    const tailBuffer = Buffer.alloc(tailLength);
    fs.readSync(fd, tailBuffer, 0, tailLength, stat.size - tailLength);

    const lines = [
      ...headBuffer.toString("utf8").split("\n"),
      ...tailBuffer.toString("utf8").split("\n").slice(1)
    ].map(line => line.trim()).filter(Boolean);
    return [...new Set(lines)];
  } finally {
    fs.closeSync(fd);
  }
}

function finalAnswerTextFromEvent(event) {
  const payload = event.payload || {};
  if (payload.type === "agent_message" && payload.phase === "final_answer" && typeof payload.message === "string") {
    return payload.message.trim();
  }
  if (event.type === "response_item" && payload.type === "message" && payload.role === "assistant") {
    return assistantTextFromObject(payload);
  }
  return "";
}

function stopWatchActiveDesktopTurnState({ meta, project, pickerItem, turn, lastUser, lastReply }) {
  let state = "thinking";
  let title = "Codex is thinking";
  let body = "Working on desktop turn";
  let activity = "desktop-thinking";

  if (turn.lastKind === "user") {
    state = "waiting";
    title = "Desktop sent";
    body = lastUser || "Desktop message sent";
    activity = "desktop-sent";
  } else if (turn.lastKind === "command") {
    state = "running";
    title = "Running command";
    body = turn.lastBody || "Executing command";
    activity = "desktop-command";
  } else if (turn.lastKind === "commentary") {
    state = "running";
    title = "Codex is updating";
    body = turn.lastBody || "Working on it";
    activity = "desktop-updating";
  }

  return {
    type: "state",
    pet: "kurisu",
    state,
    title,
    body: truncate(body, 180),
    text: turn.lastKind === "commentary" ? turn.lastBody : "",
    activity,
    lastUser,
    lastReply,
    observedAt: turn.observedAt || turn.startedAt,
    project,
    chat: meta.id,
    projectIndex: integerOrNull(pickerItem?.projectIndex),
    chatIndex: integerOrNull(pickerItem?.chatIndex)
  };
}

function stopWatchStateMessage() {
  if (latestBridgeState && normalizeStatus(latestBridgeState.state) !== "idle") {
    return latestBridgeState;
  }
  if (latestDurableState) {
    return latestDurableState;
  }
  return latestBridgeState || {
    type: "state",
    pet: "kurisu",
    state: "idle",
    title: "Codex",
    body: "Bridge ready"
  };
}

function stopWatchStateLabel(state, message = {}) {
  const combined = `${message.title || ""} ${message.body || ""}`.toLowerCase();
  if (state === "review" && message.title === "Codex replied") {
    return "REPLIED";
  }
  if (state === "waiting" && message.title === "Desktop sent") {
    return "SENT";
  }
  if (state === "running" && message.title === "Running command") {
    return "CMD";
  }
  if (state === "running" && message.title === "Codex is updating") {
    return "UPDATE";
  }
  if (state === "review" && combined.includes("approval")) {
    return "WAIT OK";
  }
  if (state === "review" && combined.includes("input")) {
    return "NEED INPUT";
  }
  switch (state) {
    case "thinking":
      return "THINKING";
    case "running":
    case "running-left":
    case "running-right":
      return "RUNNING";
    case "review":
      return "DONE";
    case "failed":
      return "ERROR";
    case "waiting":
      return "WAITING";
    default:
      return "IDLE";
  }
}

function stopWatchEventForState(state, message = {}) {
  const combined = `${message.title || ""} ${message.body || ""}`.toLowerCase();
  if (state === "failed") {
    return "failed";
  }
  if (state === "review" && combined.includes("approval")) {
    return "approval-needed";
  }
  if (state === "review" && combined.includes("input")) {
    return "input-needed";
  }
  if (state === "review") {
    return "completed";
  }
  return "none";
}

async function codexUsageSnapshot(stateMessage = {}) {
  const empty = {
    sessionTokens: null,
    lastTurnTokens: null,
    todayTokens: null,
    todayCostUSD: null,
    todayTurns: 0,
    contextWindow: null,
    primaryUsedPercent: null,
    secondaryUsedPercent: null,
    primaryRemainingPercent: null,
    secondaryRemainingPercent: null,
    primaryWindowMinutes: null,
    secondaryWindowMinutes: null,
    primaryResetsAt: null,
    secondaryResetsAt: null,
    limitId: null,
    limitName: null,
    planType: null,
    primaryQuotaState: "unknown",
    secondaryQuotaState: "unknown",
    quotaAlert: "none",
    quotaAlertLabel: "",
    updatedAt: null,
    source: "unavailable"
  };

  try {
    const cacheKey = stringOrNull(stateMessage.chat) || "latest";
    const now = Date.now();
    const cacheMs = Number(process.env.CODEX_STOPWATCH_USAGE_CACHE_MS || 30000);
    if (cachedStopWatchUsage
      && cachedStopWatchUsage.key === cacheKey) {
      if (now - cachedStopWatchUsage.createdAtMs < cacheMs) {
        return cachedStopWatchUsage.value;
      }
      if (!stopWatchUsageRefreshPromise) {
        stopWatchUsageRefreshPromise = buildCodexUsageSnapshotValue(stateMessage, empty)
          .then(value => {
            cachedStopWatchUsage = { key: cacheKey, createdAtMs: Date.now(), value };
            return value;
          })
          .catch(error => {
            warnBridge("failed to refresh StopWatch usage snapshot", error);
            return cachedStopWatchUsage?.value || empty;
          })
          .finally(() => {
            stopWatchUsageRefreshPromise = null;
          });
      }
      return cachedStopWatchUsage.value;
    }

    const value = await buildCodexUsageSnapshotValue(stateMessage, empty);
    cachedStopWatchUsage = { key: cacheKey, createdAtMs: now, value };
    return value;
  } catch (error) {
    warnBridge("failed to build StopWatch usage snapshot", error);
    return empty;
  }
}

async function buildCodexUsageSnapshotValue(stateMessage, empty) {
  const quota = await codexRateLimitSnapshot();
  const allFiles = findSessionFilesInRoots(currentCodexSessionRoots())
    .map(file => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const files = allFiles.slice(0, Number(process.env.CODEX_STOPWATCH_MAX_USAGE_FILES || 80));
  if (files.length === 0) {
    return quota ? { ...empty, ...quota } : empty;
  }

  const targetThreadId = stringOrNull(stateMessage.chat);
  const todayKey = stopWatchTodayKey();
  const todayStartMs = stopWatchStartOfDayMs(todayKey);
  let latestRecord = null;
  let latestTargetRecord = null;

  for (const { file } of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    let threadId = null;
    for (const line of lines) {
      const event = parseJSONLine(line);
      if (!event) {
        continue;
      }
      if (event.type === "session_meta" && typeof event.payload?.id === "string") {
        threadId = event.payload.id;
        continue;
      }
      const payload = event.payload || {};
      if (event.type !== "event_msg" || payload.type !== "token_count") {
        continue;
      }

      const record = tokenUsageRecord(event, file, threadId);
      if (!record) {
        continue;
      }
      if (!latestRecord || record.timestampMs > latestRecord.timestampMs) {
        latestRecord = record;
      }
      if (targetThreadId && threadId === targetThreadId
        && (!latestTargetRecord || record.timestampMs > latestTargetRecord.timestampMs)) {
        latestTargetRecord = record;
      }
    }
  }

  const chosen = latestTargetRecord || latestRecord;
  if (!chosen) {
    return empty;
  }

  const todayFiles = allFiles.filter(({ file, mtimeMs }) => {
    return !Number.isFinite(todayStartMs)
      || mtimeMs >= todayStartMs
      || file.includes(todayKey.replaceAll("-", path.sep));
  });
  const todayUsage = codexBarStyleDailyUsage(todayFiles, todayKey);
  const codexBarUsage = codexBarDailyUsageFromCache(todayKey);
  const logQuota = stopWatchQuotaFromSessionRateLimits(chosen.rateLimits, chosen.timestamp);
  const usageSource = quota
    ? quota.source
    : logQuota?.source || "codex-session-logs";
  return {
    sessionTokens: codexBarUsage?.sessionTokens ?? tokenUsageTotal(chosen.info?.total_token_usage),
    lastTurnTokens: tokenUsageTotal(chosen.info?.last_token_usage),
    todayTokens: codexBarUsage?.tokens ?? (todayUsage.turns > 0 ? todayUsage.tokens : null),
    todayCostUSD: codexBarUsage?.costUSD ?? null,
    todayTurns: todayUsage.turns,
    contextWindow: integerOrNull(chosen.info?.model_context_window),
    ...(quota || logQuota || {}),
    updatedAt: chosen.timestamp,
    source: codexBarUsage
      ? `${usageSource}+${codexBarUsage.source}`
      : `${usageSource}+codexbar-session-logs`
  };
}

async function codexRateLimitSnapshot() {
  try {
    const result = await getCodexAppServer().request("account/rateLimits/read", {}, {
      timeoutMs: Number(process.env.CODEX_STOPWATCH_RATE_LIMIT_TIMEOUT_MS || 1200)
    });
    return stopWatchQuotaFromCodexRPC(result);
  } catch (error) {
    warnBridge("failed to read Codex rate limits for StopWatch", error);
    return null;
  }
}

function stopWatchQuotaFromCodexRPC(result) {
  const limits = result?.rateLimits || result?.rate_limits;
  if (!limits || typeof limits !== "object") {
    return null;
  }
  const normalized = normalizeCodexRateWindows({
    primary: rpcRateWindow(limits.primary),
    secondary: rpcRateWindow(limits.secondary)
  });
  if (!normalized.primary && !normalized.secondary) {
    return null;
  }
  return stopWatchQuotaValue({
    ...normalized,
    limitId: stringOrNull(limits.limitId) || stringOrNull(limits.limit_id),
    limitName: stringOrNull(limits.limitName) || stringOrNull(limits.limit_name),
    planType: stringOrNull(limits.planType) || stringOrNull(limits.plan_type),
    updatedAt: new Date().toISOString(),
    source: "codex-app-server"
  });
}

function stopWatchQuotaFromSessionRateLimits(rateLimits, updatedAt) {
  if (!rateLimits || typeof rateLimits !== "object") {
    return null;
  }
  const normalized = normalizeCodexRateWindows({
    primary: sessionRateWindow(rateLimits.primary),
    secondary: sessionRateWindow(rateLimits.secondary)
  });
  if (!normalized.primary && !normalized.secondary) {
    return null;
  }
  return stopWatchQuotaValue({
    ...normalized,
    limitId: stringOrNull(rateLimits.limit_id) || stringOrNull(rateLimits.limitId),
    limitName: stringOrNull(rateLimits.limit_name) || stringOrNull(rateLimits.limitName),
    planType: stringOrNull(rateLimits.plan_type) || stringOrNull(rateLimits.planType),
    updatedAt,
    source: "codex-session-logs"
  });
}

function rpcRateWindow(window) {
  if (!window || typeof window !== "object") {
    return null;
  }
  return {
    usedPercent: numberOrNull(window.usedPercent),
    windowMinutes: integerOrNull(window.windowDurationMins),
    resetsAt: integerOrNull(window.resetsAt)
  };
}

function sessionRateWindow(window) {
  if (!window || typeof window !== "object") {
    return null;
  }
  return {
    usedPercent: numberOrNull(window.used_percent) ?? numberOrNull(window.usedPercent),
    windowMinutes: integerOrNull(window.window_minutes) ?? integerOrNull(window.windowDurationMins),
    resetsAt: integerOrNull(window.resets_at) ?? integerOrNull(window.resetsAt)
  };
}

function normalizeCodexRateWindows({ primary, secondary }) {
  const primaryRole = codexWindowRole(primary);
  const secondaryRole = codexWindowRole(secondary);
  if (primary && secondary) {
    if (primaryRole === "weekly" && secondaryRole !== "weekly") {
      return { primary: secondary, secondary: primary };
    }
    return { primary, secondary };
  }
  if (primary && primaryRole === "weekly") {
    return { primary: null, secondary: primary };
  }
  if (secondary && secondaryRole !== "weekly") {
    return { primary: secondary, secondary: null };
  }
  return { primary, secondary };
}

function codexWindowRole(window) {
  switch (window?.windowMinutes) {
    case 300:
      return "session";
    case 10080:
      return "weekly";
    default:
      return "unknown";
  }
}

function stopWatchQuotaValue({ primary, secondary, limitId, limitName, planType, updatedAt, source }) {
  const quotaAlert = stopWatchQuotaAlert({ primary, secondary });
  return {
    primaryUsedPercent: numberOrNull(primary?.usedPercent),
    secondaryUsedPercent: numberOrNull(secondary?.usedPercent),
    primaryRemainingPercent: remainingPercent(primary?.usedPercent),
    secondaryRemainingPercent: remainingPercent(secondary?.usedPercent),
    primaryWindowMinutes: integerOrNull(primary?.windowMinutes),
    secondaryWindowMinutes: integerOrNull(secondary?.windowMinutes),
    primaryResetsAt: integerOrNull(primary?.resetsAt),
    secondaryResetsAt: integerOrNull(secondary?.resetsAt),
    limitId,
    limitName,
    planType,
    ...quotaAlert,
    quotaUpdatedAt: updatedAt,
    source
  };
}

function remainingPercent(usedPercent) {
  const used = numberOrNull(usedPercent);
  return used === null ? null : Math.max(0, Math.round((100 - used) * 10) / 10);
}

function stopWatchQuotaAlert({ primary, secondary }) {
  const primaryQuotaState = quotaState(primary?.usedPercent);
  const secondaryQuotaState = quotaState(secondary?.usedPercent);
  const candidates = [
    {
      state: primaryQuotaState,
      label: stopWatchWindowLabel(primary?.windowMinutes, "5h"),
      usedPercent: numberOrNull(primary?.usedPercent)
    },
    {
      state: secondaryQuotaState,
      label: stopWatchWindowLabel(secondary?.windowMinutes, "7d"),
      usedPercent: numberOrNull(secondary?.usedPercent)
    }
  ].filter(candidate => quotaStateRank(candidate.state) > 0);

  candidates.sort((left, right) => {
    const rankDelta = quotaStateRank(right.state) - quotaStateRank(left.state);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    return (right.usedPercent ?? -1) - (left.usedPercent ?? -1);
  });

  const best = candidates[0];
  return {
    primaryQuotaState,
    secondaryQuotaState,
    quotaAlert: best?.state || "none",
    quotaAlertLabel: best ? `${best.label} ${quotaPercentLabel(best.usedPercent)}` : ""
  };
}

function quotaState(usedPercent) {
  const used = numberOrNull(usedPercent);
  if (used === null) {
    return "unknown";
  }
  if (used >= 90) {
    return "critical";
  }
  if (used >= 70) {
    return "warn";
  }
  return "normal";
}

function quotaStateRank(state) {
  if (state === "critical") {
    return 2;
  }
  if (state === "warn") {
    return 1;
  }
  return 0;
}

function stopWatchWindowLabel(windowMinutes, fallback) {
  switch (integerOrNull(windowMinutes)) {
    case 300:
      return "5h";
    case 10080:
      return "7d";
    default:
      return fallback;
  }
}

function quotaPercentLabel(value) {
  const used = numberOrNull(value);
  if (used === null) {
    return "--%";
  }
  const rounded = Math.round(used * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function parseJSONLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function tokenUsageRecord(event, file, threadId) {
  const timestamp = typeof event.timestamp === "string" ? event.timestamp : null;
  const timestampMs = timestamp ? Date.parse(timestamp) : NaN;
  const info = event.payload?.info;
  if (!Number.isFinite(timestampMs) || !info || typeof info !== "object") {
    return null;
  }
  return {
    file,
    threadId,
    timestamp,
    timestampMs,
    info,
    rateLimits: event.payload?.rate_limits || null
  };
}

function tokenUsageTotal(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (Number.isFinite(value.total_tokens)) {
    return Math.round(value.total_tokens);
  }
  const input = Number.isFinite(value.input_tokens) ? value.input_tokens : 0;
  const output = Number.isFinite(value.output_tokens) ? value.output_tokens : 0;
  const reasoning = Number.isFinite(value.reasoning_output_tokens) ? value.reasoning_output_tokens : 0;
  const total = input + output + reasoning;
  return total > 0 ? Math.round(total) : null;
}

function codexBarStyleDailyUsage(files, todayKey) {
  let tokens = 0;
  let turns = 0;
  let input = 0;
  let output = 0;
  let cached = 0;

  for (const { file } of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      const event = parseJSONLine(line);
      if (!event || event.type !== "event_msg" || event.payload?.type !== "token_count") {
        continue;
      }
      if (stopWatchDayKeyFromTimestamp(event.timestamp) !== todayKey) {
        continue;
      }

      const parts = tokenUsageParts(event.payload?.info?.last_token_usage);
      const total = parts.input + parts.output;
      if (total <= 0) {
        continue;
      }

      tokens += total;
      turns += 1;
      input += parts.input;
      output += parts.output;
      cached += Math.min(parts.cached, parts.input);
    }
  }

  return { tokens, turns, input, output, cached };
}

function codexBarDailyUsageFromCache(todayKey) {
  const widget = readJSONFile(
    process.env.CODEX_STOPWATCH_CODEXBAR_SNAPSHOT_PATH || defaultCodexBarWidgetSnapshot
  );
  const widgetEntry = widget?.entries?.find(entry => entry?.provider === "codex");
  const widgetDay = widgetEntry?.dailyUsage?.find(day => day?.dayKey === todayKey);
  const widgetTokens = integerOrNull(widgetDay?.totalTokens);
  if (widgetTokens !== null) {
    return {
      tokens: widgetTokens,
      costUSD: numberOrNull(widgetDay?.costUSD),
      sessionTokens: integerOrNull(widgetEntry?.tokenUsage?.sessionTokens) ?? widgetTokens,
      source: "codexbar-widget"
    };
  }

  const costUsage = readJSONFile(
    process.env.CODEX_STOPWATCH_CODEXBAR_COST_PATH || defaultCodexBarCostUsage
  );
  const modelUsage = costUsage?.days?.[todayKey];
  if (!modelUsage || typeof modelUsage !== "object") {
    return null;
  }

  let tokens = 0;
  for (const parts of Object.values(modelUsage)) {
    if (!Array.isArray(parts)) {
      continue;
    }
    tokens += positiveInteger(parts[0]) + positiveInteger(parts[2]);
  }

  return tokens > 0 ? { tokens, sessionTokens: tokens, source: "codexbar-cost-cache" } : null;
}

function readJSONFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function tokenUsageParts(value) {
  if (!value || typeof value !== "object") {
    return { input: 0, output: 0, cached: 0 };
  }
  return {
    input: positiveInteger(value.input_tokens),
    output: positiveInteger(value.output_tokens),
    cached: positiveInteger(value.cached_input_tokens ?? value.cache_read_input_tokens)
  };
}

function positiveInteger(value) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function stopWatchTodayKey() {
  const configured = process.env.CODEX_STOPWATCH_TODAY;
  if (typeof configured === "string" && /^\d{4}-\d{2}-\d{2}$/.test(configured)) {
    return configured;
  }
  return stopWatchDayKeyFromDate(new Date());
}

function stopWatchDayKeyFromTimestamp(timestamp) {
  if (typeof timestamp !== "string") {
    return null;
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return stopWatchDayKeyFromDate(date);
}

function stopWatchDayKeyFromDate(date) {
  const now = new Date();
  const value = date || now;
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function stopWatchStartOfDayMs(dayKey) {
  if (typeof dayKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
    return NaN;
  }
  return new Date(`${dayKey}T00:00:00`).getTime();
}

function replayStateForClient(client) {
  const durableState = durableStateBySelection.get(selectionKey(client.selection)) || latestDurableState;
  if (!durableState) {
    return null;
  }
  return {
    ...durableState,
    pet: client.pet,
    capabilities: client.capabilities,
    items: client.pickerItems,
    ...client.selection
  };
}

function clearDurableStateForClient(client) {
  const key = selectionKey(client.selection);
  const existing = durableStateBySelection.get(key);
  const signature = existing ? durableStateSignature(existing) : null;
  durableStateBySelection.delete(key);
  if (signature) {
    readStateSignaturesBySelection.set(key, signature);
  }
  if (latestDurableState && selectionKey(latestDurableState) === key && existing === latestDurableState) {
    latestDurableState = Array.from(durableStateBySelection.values()).at(-1) || null;
  }
  if (latestBridgeState
    && normalizeStatus(latestBridgeState.state) === "review"
    && selectionKey(latestBridgeState) === key
    && (!signature || durableStateSignature(latestBridgeState) === signature)) {
    latestBridgeState = latestDurableState;
  }
}

function isDurableWatchState(state) {
  return [
    "review",
    "thinking",
    "running",
    "running-left",
    "running-right"
  ].includes(state);
}

function selectionKey(value = {}) {
  return [
    value.project || "",
    value.chat || "",
    Number.isInteger(value.projectIndex) ? value.projectIndex : "",
    Number.isInteger(value.chatIndex) ? value.chatIndex : "",
    value.newChat === true ? "new" : "existing"
  ].join("\u001f");
}

function durableStateSignature(value = {}) {
  return [
    normalizeStatus(value.state),
    value.title || "",
    value.body || "",
    value.text || ""
  ].join("\u001f");
}

function send(client, message) {
  rememberDurableState(message);
  if (Array.isArray(client.queue)) {
    client.queue.push(message);
    return;
  }
  if (client.socket.destroyed) return;
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = frameHeader(payload.length);
  client.socket.write(Buffer.concat([header, payload]));
}

function broadcast(message) {
  for (const client of clients) {
    send(client, message);
  }
}

function getHTTPClient(id, socket) {
  const existing = httpClients.get(id);
  if (existing) {
    return existing;
  }

  const client = {
    id,
    queue: [],
    audioStream: null,
    audioPath: null,
    audioBytes: 0,
    audioSampleRate: 48000,
    audioChannels: 1,
    pet: "codex",
    capabilities: [],
    selection: {
      target: "chat",
      project: "project-1",
      chat: "chat-1",
      projectIndex: 0,
      chatIndex: 0,
      newChat: false
    },
    pickerItems: loadCodexPickerItems()
  };
  httpClients.set(id, client);
  clients.add(client);
  logConnection("watch http connected", socket);
  return client;
}

function getStopWatchHTTPClient(socket) {
  const client = getHTTPClient("stopwatch-device", socket);
  const stateMessage = stopWatchStateMessage();
  client.capabilities = [...new Set([...(client.capabilities || []), "stopwatch-voice"])];
  client.pickerItems = loadCodexPickerItems();
  client.selection.target = "chat";

  if (typeof stateMessage.project === "string" && stateMessage.project.length > 0) {
    client.selection.project = stateMessage.project;
  }
  if (typeof stateMessage.chat === "string" && stateMessage.chat.length > 0) {
    client.selection.chat = stateMessage.chat;
  }
  if (Number.isInteger(stateMessage.projectIndex)) {
    client.selection.projectIndex = stateMessage.projectIndex;
  }
  if (Number.isInteger(stateMessage.chatIndex)) {
    client.selection.chatIndex = stateMessage.chatIndex;
  }
  return client;
}

function clientIDFromURL(requestURL) {
  const id = requestURL.searchParams.get("client");
  if (id && /^[A-Za-z0-9._:-]{1,80}$/.test(id)) {
    return id;
  }
  return "watch-http-default";
}

function drainQueuedMessages(client) {
  if (!Array.isArray(client.queue)) {
    return [];
  }
  return client.queue.splice(0, client.queue.length);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function readRequestBuffer(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function jsonResponse(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    connection: "close"
  });
  response.end(body);
}

function boundPort(server) {
  const address = server.address();
  return typeof address === "object" && address ? address.port : port;
}

function isMainModule() {
  return process.argv[1]
    ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false;
}

export function resetBridgeStateForTests() {
  for (const client of clients) {
    try {
      client.audioStream?.destroy();
      client.socket?.destroy();
    } catch {}
  }
  clients.clear();
  httpClients.clear();
  durableStateBySelection.clear();
  readStateSignaturesBySelection.clear();
  latestDurableState = null;
  latestBridgeState = null;
  cachedStopWatchUsage = null;
  stopWatchUsageRefreshPromise = null;
  codexAppServer?.dispose?.();
  codexAppServer = null;
}

function frameHeader(length) {
  if (length < 126) {
    return Buffer.from([0x81, length]);
  }
  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}

function closeClient(client, options = {}) {
  const hadClient = clients.delete(client);
  stopAudio(client);
  if (options.replyClose && !client.socket.destroyed) {
    try {
      client.socket.write(Buffer.from([0x88, 0x00]));
    } catch {}
  }
  try {
    client.socket.end();
  } catch {}
  if (hadClient) {
    console.log(`watch disconnected (${clients.size} client${clients.size === 1 ? "" : "s"})`);
  }
}

function lanAddress() {
  const candidates = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const entry of addresses || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        candidates.push(entry);
      }
    }
  }
  return candidates.find(entry => !entry.address.endsWith(".1"))?.address
    || candidates[0]?.address
    || "127.0.0.1";
}

function localHostName() {
  if (process.env.CODEX_WATCH_LOCAL_HOSTNAME) {
    return process.env.CODEX_WATCH_LOCAL_HOSTNAME;
  }
  try {
    return execFileSync("scutil", ["--get", "LocalHostName"], { encoding: "utf8" }).trim()
      || os.hostname().split(".")[0];
  } catch {
    return os.hostname().split(".")[0];
  }
}

function logConnection(label, socket) {
  const summary = `${label} (${clients.size} client${clients.size === 1 ? "" : "s"})`;
  if (verboseBridgeLogging) {
    console.log(summary, `from ${socket.remoteAddress || "unknown"}:${socket.remotePort || "?"}`);
  } else {
    console.log(summary);
  }
}

function logVerbose(...args) {
  if (verboseBridgeLogging) {
    console.log(...args);
  }
}

function warnBridge(message, error) {
  if (verboseBridgeLogging) {
    console.warn(message, error?.message || error);
  } else {
    console.warn(message);
  }
}

function errorBridge(message, error) {
  if (verboseBridgeLogging) {
    console.error(message, error?.message || error);
  } else {
    console.error(message);
  }
}

function redactedSelectionID(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "none";
  }
  if (value.startsWith("project:")) {
    return "project";
  }
  if (value.startsWith("new-chat:")) {
    return "new-chat";
  }
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}

function maybeOpenCodex() {
  if (process.env.CODEX_WATCH_OPEN_CODEX !== "1") {
    return;
  }
  execFile("open", ["-a", "Codex"], () => {});
}

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.message = stderr?.trim()
          ? `${error.message}: ${stderr.trim()}`
          : error.message;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}
