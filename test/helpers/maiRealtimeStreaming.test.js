const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const WS = require("ws");

const load = () => import("../../src/helpers/maiRealtimeStreaming.js");

function makeFakeSocket() {
  const socket = new EventEmitter();
  socket.readyState = WS.CONNECTING;
  socket.sent = [];
  socket.send = (data) => socket.sent.push(JSON.parse(data));
  socket.ping = () => socket.emit("pong");
  socket.terminate = () => {
    socket.readyState = WS.CLOSED;
  };
  socket.close = () => {
    socket.readyState = WS.CLOSED;
  };
  return socket;
}

async function connectWith(endpoint, options = {}) {
  const { MaiRealtimeStreaming } = await load();
  const socket = makeFakeSocket();
  const opened = [];
  const streaming = new MaiRealtimeStreaming((url, socketOptions) => {
    opened.push({ url, socketOptions });
    return socket;
  });
  const connecting = streaming.connect({ apiKey: "ms-key", endpoint, ...options });
  await new Promise((resolve) => setImmediate(resolve));
  socket.readyState = WS.OPEN;
  socket.emit("message", JSON.stringify({ type: "session.created" }));
  socket.emit("message", JSON.stringify({ type: "session.updated" }));
  await connecting;
  return { streaming, socket, opened };
}

test("opens the resource's Foundry socket with the key in the api-key header", async () => {
  const { streaming, opened } = await connectWith("https://acme.cognitiveservices.azure.com/");
  assert.deepEqual(opened, [
    {
      url: "wss://acme.services.ai.azure.com/mai/v1/realtime?intent=transcription",
      socketOptions: { headers: { "api-key": "ms-key" } },
    },
  ]);
  streaming.cleanup();
});

test("a region or a foreign host never opens a socket", async () => {
  const { MaiRealtimeStreaming } = await load();
  for (const endpoint of ["northeurope", "https://evil.example.com", "", undefined]) {
    let opened = false;
    const streaming = new MaiRealtimeStreaming(() => {
      opened = true;
      return makeFakeSocket();
    });
    await assert.rejects(streaming.connect({ apiKey: "ms-key", endpoint }), /resource endpoint/);
    assert.equal(opened, false, String(endpoint));
  }
});

test("configures the deployment, the language and no turn detection", async () => {
  const { streaming, socket } = await connectWith("https://acme.services.ai.azure.com", {
    language: "fr",
    inputRate: 24000,
  });
  const update = socket.sent.find((event) => event.type === "session.update");
  assert.deepEqual(update.session.audio.input, {
    format: { type: "audio/pcm", rate: 24000 },
    transcription: { model: "MAI-Transcribe-2-Streaming", language: "fr" },
    turn_detection: null,
  });
  streaming.cleanup();
});

test("the live line is the finalized deltas plus the current intermediate", async () => {
  const { streaming, socket } = await connectWith("https://acme.services.ai.azure.com");
  const partials = [];
  streaming.onPartialTranscript = (text) => partials.push(text);
  const send = (event) =>
    socket.emit("message", JSON.stringify({ item_id: "item_1", content_index: 0, ...event }));
  send({ type: "conversation.item.input_audio_transcription.delta", delta: "Hello" });
  send({ type: "conversation.item.input_audio_transcription.intermediate", intermediate: " wor" });
  send({
    type: "conversation.item.input_audio_transcription.intermediate",
    intermediate: " world",
  });
  assert.deepEqual(partials, ["Hello", "Hello wor", "Hello world"]);
  streaming.cleanup();
});
