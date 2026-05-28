import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { once } from "node:events";
import {
  codexInputTextForTranscript,
  resetBridgeStateForTests,
  startBridge
} from "../../bridge/codex-watch-bridge.mjs";

let server;
let tempDir;
let originalEnv;

describe("Codex Watch bridge E2E", { concurrency: false }, () => {
  beforeEach(async () => {
    originalEnv = { ...process.env };
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-watch-bridge-test-"));
    await writeSessionFixture(tempDir, {
      threadId: "thread-e2e-1",
      cwd: path.join(tempDir, "project-one"),
      prompt: "Initial fixture prompt"
    });
    process.env.CODEX_SESSIONS_DIR = tempDir;
    process.env.CODEX_STOPWATCH_CODEXBAR_SNAPSHOT_PATH = path.join(tempDir, "missing-widget-snapshot.json");
    process.env.CODEX_STOPWATCH_CODEXBAR_COST_PATH = path.join(tempDir, "missing-codex-cost.json");
    process.env.CODEX_WATCH_MOCK_APP_SERVER = "1";
    process.env.CODEX_WATCH_MOCK_REPLY = "Mock **reply** with `inlineCode`.";
    resetBridgeStateForTests();
    server = startBridge({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
  });

  afterEach(async () => {
    await closeServer(server);
    server = null;
    resetBridgeStateForTests();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    process.env = originalEnv;
  });

  test("hello returns bridge state and real picker items from Codex sessions", async () => {
    const response = await postMessage("hello-client", {
      type: "hello",
      pet: "codex",
      capabilities: ["codex-pets", "project-chat-picker"]
    });

    assert.equal(response.ok, true);
    assert.equal(response.messages.at(-1)?.title, "Codex");
    assert.equal(response.messages.at(-1)?.body, "Bridge ready");
    assert.ok(response.messages.at(-1)?.items.some(item => item.chat === "thread-e2e-1"));
    assert.ok(response.messages.at(-1)?.items.some(item => item.kind === "project"));
  });

  test("transcript-send starts a Codex turn and streams status events back to the watch", async () => {
    const longReply = "This response sends transcripts into Codex chats without losing the expanded markdown body. It includes enough detail to exceed the card preview limit while preserving the complete text for the watch reader, including `inlineCode` and **bold** markdown.";
    process.env.CODEX_WATCH_MOCK_REPLY = longReply;

    await postMessage("send-client", {
      type: "hello",
      pet: "codex",
      capabilities: ["codex-pets"]
    });

    const sendResponse = await postMessage("send-client", {
      type: "transcript-send",
      pet: "codex",
      text: "Summarize `inlineCode` please.",
      project: `project:${path.join(tempDir, "project-one")}`,
      chat: "thread-e2e-1",
      target: "chat"
    });

    assert.equal(sendResponse.ok, true);
    assert.ok(sendResponse.messages.some(message => message.title === "Sending"));

    const messages = await pollUntil("send-client", allMessages => {
      const titles = allMessages.map(message => message.title);
      return titles.includes("Codex is thinking") && titles.includes("Codex replied");
    });

    assert.equal(messages.find(message => message.title === "Codex is thinking")?.state, "thinking");
    assert.equal(messages.find(message => message.title === "Codex is thinking")?.body, "Working on it");
    assert.ok(messages.some(message => message.title === "Codex is replying"));
    assert.ok(messages.some(message => message.body?.includes("inlineCode")));
    const finalReply = messages.findLast(message => message.title === "Codex replied");
    assert.equal(finalReply?.state, "review");
    assert.equal(finalReply?.text, longReply);
    assert.ok((finalReply?.body?.length || 0) < longReply.length);
    assert.match(finalReply?.body || "", /\.\.\.$/);
  });

  test("reconnecting clients receive the last unread reply until it is read", async () => {
    const project = `project:${path.join(tempDir, "project-one")}`;

    await postMessage("replay-source", {
      type: "state",
      pet: "codex",
      state: "review",
      title: "Codex replied",
      body: "Unread preview",
      text: "Unread full body",
      project,
      chat: "thread-e2e-1",
      projectIndex: 0,
      chatIndex: 0
    });

    const replay = await postMessage("replay-target", {
      type: "hello",
      pet: "codex",
      capabilities: ["codex-pets"],
      project,
      chat: "thread-e2e-1",
      projectIndex: 0,
      chatIndex: 0
    });

    assert.equal(replay.messages.at(-1)?.title, "Codex replied");
    assert.equal(replay.messages.at(-1)?.state, "review");
    assert.equal(replay.messages.at(-1)?.text, "Unread full body");

    await postMessage("replay-target", {
      type: "message-read",
      pet: "codex",
      project,
      chat: "thread-e2e-1",
      projectIndex: 0,
      chatIndex: 0
    });

    const afterRead = await postMessage("replay-after-read", {
      type: "hello",
      pet: "codex",
      capabilities: ["codex-pets"],
      project,
      chat: "thread-e2e-1",
      projectIndex: 0,
      chatIndex: 0
    });

    assert.equal(afterRead.messages.at(-1)?.title, "Codex");
    assert.equal(afterRead.messages.at(-1)?.body, "Bridge ready");
  });

  test("reconnecting clients receive thinking state", async () => {
    const project = `project:${path.join(tempDir, "project-one")}`;

    await postMessage("thinking-source", {
      type: "state",
      pet: "codex",
      state: "thinking",
      title: "Codex is thinking",
      body: "Working on it",
      project,
      chat: "thread-e2e-1",
      projectIndex: 0,
      chatIndex: 0
    });

    const replay = await postMessage("thinking-target", {
      type: "hello",
      pet: "codex",
      capabilities: ["codex-pets"],
      project,
      chat: "thread-e2e-1",
      projectIndex: 0,
      chatIndex: 0
    });

    assert.equal(replay.messages.at(-1)?.title, "Codex is thinking");
    assert.equal(replay.messages.at(-1)?.state, "thinking");
    assert.equal(replay.messages.at(-1)?.body, "Working on it");
  });

  test("hello refreshes the selected chat state from Codex on app open", async () => {
    process.env.CODEX_WATCH_MOCK_RESUME_REPLY = "Reply created while the watch app was closed.";

    await postMessage("refresh-client", {
      type: "hello",
      pet: "codex",
      capabilities: ["codex-pets"],
      project: `project:${path.join(tempDir, "project-one")}`,
      chat: "thread-e2e-1",
      projectIndex: 0,
      chatIndex: 0
    });

    const messages = await pollUntil("refresh-client", allMessages => {
      return allMessages.some(message => message.title === "Codex replied");
    });

    const refreshed = messages.findLast(message => message.title === "Codex replied");
    assert.equal(refreshed?.state, "review");
    assert.equal(refreshed?.text, "Reply created while the watch app was closed.");
  });

  test("new chat transcript creates a Codex thread before starting the turn", async () => {
    const project = `project:${path.join(tempDir, "project-one")}`;

    await postMessage("new-chat-client", {
      type: "hello",
      pet: "codex",
      capabilities: ["codex-pets"],
      project,
      chat: `new-chat:${project}`,
      target: "chat",
      action: "new-chat",
      newChat: true
    });

    const sendResponse = await postMessage("new-chat-client", {
      type: "transcript-send",
      pet: "codex",
      text: "Start this as a fresh chat.",
      project,
      chat: `new-chat:${project}`,
      target: "chat",
      newChat: true
    });

    assert.equal(sendResponse.ok, true);
    assert.ok(sendResponse.messages.some(message => message.title === "Starting chat"));

    const messages = await pollUntil("new-chat-client", allMessages => {
      return allMessages.some(message => message.title === "Codex replied");
    });

    const finalReply = messages.findLast(message => message.title === "Codex replied");
    assert.equal(finalReply?.state, "review");
    assert.match(finalReply?.chat || "", /^mock-new-thread-/);
    assert.equal(finalReply?.newChat, false);
  });

  test("split reply deltas preserve spaces between sentences", async () => {
    process.env.CODEX_WATCH_MOCK_REPLY_CHUNKS = JSON.stringify([
      "First sentence.",
      "Second sentence.",
      " `inlineCode` remains spaced."
    ]);

    await postMessage("split-client", {
      type: "hello",
      pet: "codex",
      capabilities: ["codex-pets"]
    });

    await postMessage("split-client", {
      type: "transcript-send",
      pet: "codex",
      text: "Send split chunks.",
      project: `project:${path.join(tempDir, "project-one")}`,
      chat: "thread-e2e-1",
      target: "chat"
    });

    const messages = await pollUntil("split-client", allMessages => {
      return allMessages.some(message => message.title === "Codex replied");
    });

    const finalReply = messages.findLast(message => message.title === "Codex replied");
    assert.equal(finalReply?.text, "First sentence. Second sentence. `inlineCode` remains spaced.");
  });

  test("watch audio pipeline emits transcribing state then transcript text", async () => {
    process.env.CODEX_WATCH_TRANSCRIBE_PROVIDER = "mock";
    process.env.CODEX_WATCH_MOCK_TRANSCRIPT = "Mock transcript with `inlineCode`.";

    await postMessage("mic-client", {
      type: "hello",
      pet: "codex",
      capabilities: ["mic-stream-pcm-f32le"]
    });

    await postMessage("mic-client", {
      type: "mic-start",
      pet: "codex",
      sampleRate: 16000,
      channels: 1
    });
    await postMessage("mic-client", {
      type: "mic-chunk",
      pet: "codex",
      sampleRate: 16000,
      channels: 1,
      encoding: "pcm-f32le",
      data: pcmFloatChunk().toString("base64")
    });
    await postMessage("mic-client", {
      type: "mic-stop",
      pet: "codex"
    });

    const messages = await pollUntil("mic-client", allMessages => {
      return allMessages.some(message => message.title === "Transcribing")
        && allMessages.some(message => message.type === "transcript");
    });

    assert.equal(messages.find(message => message.title === "Transcribing")?.state, "running");
    assert.equal(messages.find(message => message.type === "transcript")?.text, "Mock transcript with `inlineCode`.");
  });

  test("desktop runtime states are normalized for the watch", async () => {
    process.env.CODEX_WATCH_MOCK_ACTIVE_FLAG = "waitingOnApproval";

    await postMessage("state-client", {
      type: "hello",
      pet: "codex",
      capabilities: ["codex-pets"]
    });

    await postMessage("state-client", {
      type: "transcript-send",
      pet: "codex",
      text: "Ship it.",
      project: `project:${path.join(tempDir, "project-one")}`,
      chat: "thread-e2e-1",
      target: "chat"
    });

    const messages = await pollUntil("state-client", allMessages => {
      return allMessages.some(message => message.title === "Approval needed");
    });

    const approval = messages.find(message => message.title === "Approval needed");
    assert.equal(approval?.state, "review");
    assert.match(approval?.body || "", /approval/i);
  });

  test("empty transcript-send returns a watch-visible failure state", async () => {
    const response = await postMessage("empty-client", {
      type: "transcript-send",
      pet: "codex",
      text: "   "
    });

    assert.equal(response.ok, true);
    assert.equal(response.messages.at(-1)?.title, "Send failed");
    assert.equal(response.messages.at(-1)?.state, "failed");
    assert.match(response.messages.at(-1)?.body || "", /empty/i);
  });

  test("transcript text is wrapped with a Chinese reply preference", () => {
    const input = codexInputTextForTranscript("Explain this error.");

    assert.match(input, /简体中文/);
    assert.match(input, /Codex companion 语音转写内容/);
    assert.match(input, /Explain this error\.$/);
  });

  test("StopWatch voice endpoint returns a transcript from PCM16 audio", async () => {
    process.env.CODEX_WATCH_TRANSCRIBE_PROVIDER = "mock";
    process.env.CODEX_WATCH_MOCK_TRANSCRIPT = "蓝色按钮测试。";
    await postMessage("stopwatch-state-source", {
      type: "state",
      pet: "codex",
      state: "idle",
      title: "Codex",
      body: "Bridge ready",
      project: `project:${path.join(tempDir, "project-one")}`,
      chat: "thread-e2e-1",
      projectIndex: 0,
      chatIndex: 0
    });

    const response = await postBinary("/codex-stopwatch/voice", pcm16ToneChunk(), {
      "content-type": "application/octet-stream",
      "x-audio-encoding": "pcm-s16le",
      "x-sample-rate": "16000",
      "x-channels": "1"
    });
    const snapshot = await getStopWatchState();

    assert.equal(response.ok, true);
    assert.equal(response.transcript, "蓝色按钮测试。");
    assert.equal(response.sampleRate, 16000);
    assert.equal(snapshot.state, "review");
    assert.equal(snapshot.title, "Transcript");
    assert.equal(snapshot.text, "蓝色按钮测试。");
  });

  test("StopWatch transcript endpoint sends confirmed text into the selected Codex chat", async () => {
    await postMessage("stopwatch-state-source", {
      type: "state",
      pet: "codex",
      state: "idle",
      title: "Codex",
      body: "Bridge ready",
      project: `project:${path.join(tempDir, "project-one")}`,
      chat: "thread-e2e-1",
      projectIndex: 0,
      chatIndex: 0
    });

    const response = await postJSON("/codex-stopwatch/transcript", {
      text: "请总结这个错误。",
      chat: "thread-e2e-1"
    });
    const messages = await pollUntil("stopwatch-device", allMessages => {
      return allMessages.some(message => message.title === "Codex replied");
    });

    assert.equal(response.ok, true);
    assert.equal(response.chat, "thread-e2e-1");
    assert.ok(messages.some(message => message.title === "Sending"));
    assert.ok(messages.some(message => message.title === "Codex replied"));
  });

  test("StopWatch visible UI mode sends confirmed text through the Codex desktop surface", async () => {
    process.env.CODEX_STOPWATCH_SEND_MODE = "visible-ui";
    process.env.CODEX_STOPWATCH_UI_SEND_MOCK = "1";
    process.env.CODEX_STOPWATCH_UI_REPLY_TIMEOUT_MS = "3000";
    await postMessage("stopwatch-state-source", {
      type: "state",
      pet: "codex",
      state: "idle",
      title: "Codex",
      body: "Bridge ready",
      project: `project:${path.join(tempDir, "project-one")}`,
      chat: "thread-e2e-1",
      projectIndex: 0,
      chatIndex: 0
    });

    const response = await postJSON("/codex-stopwatch/transcript", {
      text: "显示在当前 Codex 窗口。",
      chat: "thread-e2e-1"
    });
    const messages = await pollUntil("stopwatch-device", allMessages => {
      return allMessages.some(message => message.title === "Codex UI sent");
    });
    await appendAgentMessageFixture("thread-e2e-1", {
      phase: "commentary",
      message: "中间状态不应该显示到表上。"
    });
    await appendAgentMessageFixture("thread-e2e-1", {
      phase: "final_answer",
      message: "最终回复第一行。\n最终回复第二行。\n最终回复第三行。\n最终回复第四行。"
    });
    const repliedMessages = await pollUntil("stopwatch-device", allMessages => {
      return allMessages.some(message => message.title === "Codex replied");
    }, 4000);
    const finalReply = repliedMessages.findLast(message => message.title === "Codex replied");
    const stopwatchState = await getStopWatchState();

    assert.equal(response.ok, true);
    assert.equal(response.sendMode, "visible-ui");
    assert.equal(response.chat, "thread-e2e-1");
    assert.ok(messages.some(message => message.title === "Sending to Codex"));
    assert.ok(messages.some(message => message.title === "Codex UI sent"));
    assert.equal(finalReply?.text, "最终回复第一行。\n最终回复第二行。\n最终回复第三行。\n最终回复第四行。");
    assert.equal(finalReply?.body, "最终回复第一行。\n最终回复第二行。\n最终回复第三行。");
    assert.equal(stopwatchState.label, "REPLIED");
    assert.equal(stopwatchState.body, "最终回复第一行。\n最终回复第二行。\n最终回复第三行。");
  });

  test("StopWatch endpoint follows desktop Codex session activity from logs", async () => {
    await appendSessionEventFixture("thread-e2e-1", {
      timestamp: "2026-05-24T15:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "desktop-turn-1"
      }
    });
    await appendSessionEventFixture("thread-e2e-1", {
      timestamp: "2026-05-24T15:01:01.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "桌面端直接发一条。"
      }
    });

    let snapshot = await getStopWatchState();
    assert.equal(snapshot.label, "SENT");
    assert.equal(snapshot.title, "Desktop sent");
    assert.equal(snapshot.recent.user, "桌面端直接发一条。");

    await appendSessionEventFixture("thread-e2e-1", {
      timestamp: "2026-05-24T15:01:02.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command"
      }
    });

    snapshot = await getStopWatchState();
    assert.equal(snapshot.label, "CMD");
    assert.equal(snapshot.title, "Running command");
    assert.equal(snapshot.recent.activity, "desktop-command");

    await appendSessionEventFixture("thread-e2e-1", {
      timestamp: "2026-05-24T15:01:03.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        phase: "final_answer",
        message: "桌面回复第一行。\n桌面回复第二行。\n桌面回复第三行。\n桌面回复第四行。"
      }
    });
    await appendSessionEventFixture("thread-e2e-1", {
      timestamp: "2026-05-24T15:01:04.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "desktop-turn-1",
        last_agent_message: "桌面回复第一行。\n桌面回复第二行。\n桌面回复第三行。\n桌面回复第四行。"
      }
    });

    snapshot = await getStopWatchState();
    assert.equal(snapshot.label, "REPLIED");
    assert.equal(snapshot.title, "Codex replied");
    assert.equal(snapshot.body, "桌面回复第一行。\n桌面回复第二行。\n桌面回复第三行。");
    assert.equal(snapshot.text, "桌面回复第一行。\n桌面回复第二行。\n桌面回复第三行。");
    assert.equal(snapshot.recent.reply, "桌面回复第一行。\n桌面回复第二行。\n桌面回复第三行。");
  });

  test("StopWatch endpoint returns compact state and best-effort usage", async () => {
    process.env.CODEX_STOPWATCH_TODAY = "2026-05-24";
    await appendTokenUsageFixture("thread-e2e-1", {
      inputTokens: 120,
      cachedInputTokens: 80,
      outputTokens: 30,
      reasoningOutputTokens: 10,
      totalTokens: 160,
      sessionTotalTokens: 3200,
      primaryUsedPercent: 41,
      secondaryUsedPercent: 7
    });
    await appendTokenUsageFixture("thread-e2e-1", {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 900,
      sessionTotalTokens: 4100,
      primaryUsedPercent: 41,
      secondaryUsedPercent: 7
    });

    await postMessage("stopwatch-state-source", {
      type: "state",
      pet: "codex",
      state: "review",
      title: "Approval needed",
      body: "Codex is waiting for approval",
      project: `project:${path.join(tempDir, "project-one")}`,
      chat: "thread-e2e-1",
      projectIndex: 0,
      chatIndex: 0
    });

    const snapshot = await getStopWatchState();

    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.type, "stopwatch-state");
    assert.equal(snapshot.state, "review");
    assert.equal(snapshot.label, "WAIT OK");
    assert.equal(snapshot.event, "approval-needed");
    assert.equal(snapshot.usage.lastTurnTokens, 160);
    assert.equal(snapshot.usage.sessionTokens, 3200);
    assert.equal(snapshot.usage.todayTokens, 150);
    assert.equal(snapshot.usage.todayTurns, 1);
    assert.equal(snapshot.usage.primaryUsedPercent, 41);
    assert.equal(snapshot.selection.chat, "thread-e2e-1");
  });

  test("StopWatch endpoint prefers Codex app-server quota windows", async () => {
    process.env.CODEX_STOPWATCH_TODAY = "2026-05-24";
    process.env.CODEX_WATCH_MOCK_RATE_LIMITS_JSON = JSON.stringify({
      rateLimits: {
        limitId: "codex",
        limitName: null,
        primary: {
          usedPercent: 4,
          windowDurationMins: 300,
          resetsAt: 1779970849
        },
        secondary: {
          usedPercent: 42,
          windowDurationMins: 10080,
          resetsAt: 1780187853
        },
        planType: "pro"
      }
    });
    await appendTokenUsageFixture("thread-e2e-1", {
      inputTokens: 120,
      cachedInputTokens: 80,
      outputTokens: 30,
      reasoningOutputTokens: 10,
      totalTokens: 160,
      sessionTotalTokens: 3200,
      primaryUsedPercent: 99,
      secondaryUsedPercent: 88
    });

    const snapshot = await getStopWatchState();

    assert.equal(snapshot.usage.primaryUsedPercent, 4);
    assert.equal(snapshot.usage.secondaryUsedPercent, 42);
    assert.equal(snapshot.usage.primaryWindowMinutes, 300);
    assert.equal(snapshot.usage.secondaryWindowMinutes, 10080);
    assert.equal(snapshot.usage.primaryRemainingPercent, 96);
    assert.equal(snapshot.usage.secondaryRemainingPercent, 58);
    assert.equal(snapshot.usage.primaryQuotaState, "normal");
    assert.equal(snapshot.usage.secondaryQuotaState, "normal");
    assert.equal(snapshot.usage.quotaAlert, "none");
    assert.equal(snapshot.usage.quotaAlertLabel, "");
    assert.equal(snapshot.usage.planType, "pro");
    assert.match(snapshot.usage.source, /codex-app-server/);
  });

  test("StopWatch endpoint marks high quota windows for compact alerts", async () => {
    process.env.CODEX_STOPWATCH_TODAY = "2026-05-24";
    process.env.CODEX_WATCH_MOCK_RATE_LIMITS_JSON = JSON.stringify({
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 91,
          windowDurationMins: 300,
          resetsAt: 1779970849
        },
        secondary: {
          usedPercent: 76,
          windowDurationMins: 10080,
          resetsAt: 1780187853
        },
        planType: "pro"
      }
    });
    await appendTokenUsageFixture("thread-e2e-1", {
      inputTokens: 120,
      cachedInputTokens: 80,
      outputTokens: 30,
      reasoningOutputTokens: 10,
      totalTokens: 160,
      sessionTotalTokens: 3200,
      primaryUsedPercent: 12,
      secondaryUsedPercent: 14
    });

    const snapshot = await getStopWatchState();

    assert.equal(snapshot.usage.primaryQuotaState, "critical");
    assert.equal(snapshot.usage.secondaryQuotaState, "warn");
    assert.equal(snapshot.usage.quotaAlert, "critical");
    assert.equal(snapshot.usage.quotaAlertLabel, "5h 91%");
  });

  test("StopWatch endpoint prefers CodexBar cached daily usage for TODAY", async () => {
    process.env.CODEX_STOPWATCH_TODAY = "2026-05-24";
    const snapshotPath = path.join(tempDir, "widget-snapshot.json");
    process.env.CODEX_STOPWATCH_CODEXBAR_SNAPSHOT_PATH = snapshotPath;
    await fs.writeFile(snapshotPath, JSON.stringify({
      entries: [{
        provider: "codex",
        tokenUsage: {
          sessionTokens: 9898
        },
        dailyUsage: [
          { dayKey: "2026-05-24", totalTokens: 4242, costUSD: 12.3456 }
        ]
      }]
    }));
    await appendTokenUsageFixture("thread-e2e-1", {
      inputTokens: 120,
      cachedInputTokens: 80,
      outputTokens: 30,
      reasoningOutputTokens: 10,
      totalTokens: 160,
      sessionTotalTokens: 3200,
      primaryUsedPercent: 41,
      secondaryUsedPercent: 7
    });

    const snapshot = await getStopWatchState();

    assert.equal(snapshot.usage.todayTokens, 4242);
    assert.equal(snapshot.usage.todayCostUSD, 12.3456);
    assert.equal(snapshot.usage.sessionTokens, 9898);
    assert.equal(snapshot.usage.todayTurns, 1);
    assert.match(snapshot.usage.source, /codexbar-widget/);
  });

  test("pairing token rejects unauthorized HTTP bridge clients", async () => {
    process.env.CODEX_WATCH_PAIRING_TOKEN = "secret-watch-token";
    await closeServer(server);
    resetBridgeStateForTests();
    server = startBridge({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");

    const rejected = await postMessage("token-client", {
      type: "hello",
      pet: "codex"
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /Unauthorized/);

    const accepted = await postMessage("token-client", {
      type: "hello",
      pet: "codex"
    }, { token: "secret-watch-token" });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.messages.at(-1)?.body, "Bridge ready");
  });
});

async function writeSessionFixture(root, { threadId, cwd, prompt }) {
  const directory = path.join(root, "2026", "05", "24");
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  const file = path.join(directory, `${threadId}.jsonl`);
  const lines = [
    {
      type: "session_meta",
      payload: {
        id: threadId,
        cwd,
        timestamp: "2026-05-24T15:00:00.000Z",
        source: "test"
      }
    },
    {
      type: "message",
      payload: {
        role: "user",
        message: prompt
      }
    }
  ];
  await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
}

async function appendTokenUsageFixture(threadId, {
  inputTokens,
  cachedInputTokens,
  outputTokens,
  reasoningOutputTokens,
  totalTokens,
  sessionTotalTokens,
  primaryUsedPercent,
  secondaryUsedPercent
}) {
  const file = path.join(tempDir, "2026", "05", "24", `${threadId}.jsonl`);
  const event = {
    timestamp: "2026-05-24T08:30:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: sessionTotalTokens - outputTokens,
          cached_input_tokens: cachedInputTokens,
          output_tokens: outputTokens,
          reasoning_output_tokens: reasoningOutputTokens,
          total_tokens: sessionTotalTokens
        },
        last_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: cachedInputTokens,
          output_tokens: outputTokens,
          reasoning_output_tokens: reasoningOutputTokens,
          total_tokens: totalTokens
        },
        model_context_window: 258400
      },
      rate_limits: {
        primary: {
          used_percent: primaryUsedPercent,
          window_minutes: 300,
          resets_at: 1779773228
        },
        secondary: {
          used_percent: secondaryUsedPercent,
          window_minutes: 10080,
          resets_at: 1780187853
        }
      }
    }
  };
  await fs.appendFile(file, `${JSON.stringify(event)}\n`);
}

async function appendAgentMessageFixture(threadId, { phase, message }) {
  const file = path.join(tempDir, "2026", "05", "24", `${threadId}.jsonl`);
  const event = {
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "agent_message",
      phase,
      message
    }
  };
  await fs.appendFile(file, `${JSON.stringify(event)}\n`);
}

async function appendSessionEventFixture(threadId, event) {
  const file = path.join(tempDir, "2026", "05", "24", `${threadId}.jsonl`);
  await fs.appendFile(file, `${JSON.stringify(event)}\n`);
}

function baseURL() {
  const address = server.address();
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}

async function postMessage(client, message, options = {}) {
  const url = new URL(`${baseURL()}/codex-watch/message`);
  url.searchParams.set("client", client);
  if (options.token) {
    url.searchParams.set("token", options.token);
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message)
  });
  return response.json();
}

async function poll(client) {
  const response = await fetch(`${baseURL()}/codex-watch/poll?client=${client}`);
  return response.json();
}

async function getStopWatchState() {
  const response = await fetch(`${baseURL()}/codex-stopwatch/state`);
  return response.json();
}

async function postBinary(pathname, body, headers = {}) {
  const response = await fetch(`${baseURL()}${pathname}`, {
    method: "POST",
    headers,
    body
  });
  return response.json();
}

async function postJSON(pathname, body) {
  const response = await fetch(`${baseURL()}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.json();
}

async function pollUntil(client, predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  const allMessages = [];

  while (Date.now() - startedAt < timeoutMs) {
    const response = await poll(client);
    allMessages.push(...response.messages);
    if (predicate(allMessages)) {
      return allMessages;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  assert.fail(`Timed out waiting for messages. Saw: ${JSON.stringify(allMessages)}`);
}

function pcmFloatChunk() {
  const buffer = Buffer.alloc(64 * 4);
  for (let index = 0; index < 64; index += 1) {
    buffer.writeFloatLE(Math.sin(index / 8) * 0.25, index * 4);
  }
  return buffer;
}

function pcm16ToneChunk() {
  const sampleRate = 16000;
  const samples = 800;
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const sample = Math.sin((index / sampleRate) * 440 * Math.PI * 2) * 0.2;
    buffer.writeInt16LE(Math.round(sample * 0x7fff), index * 2);
  }
  return buffer;
}

function closeServer(activeServer) {
  return new Promise(resolve => {
    activeServer.close(() => resolve());
  });
}
