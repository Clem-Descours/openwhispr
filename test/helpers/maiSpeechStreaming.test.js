const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/maiSpeechStreaming.js");

// A stand-in for the Speech SDK: records how it was configured and lets a test
// fire the recognizer's events.
function makeFakeSdk({ startFails = false } = {}) {
  const calls = {
    endpoint: null,
    subscription: null,
    written: [],
    closed: false,
    recognizer: null,
  };
  class SpeechConfig {
    constructor() {
      this.properties = {};
    }
    static fromEndpoint(url, key) {
      calls.endpoint = { url: url.href, key };
      return new SpeechConfig();
    }
    static fromSubscription(key, region) {
      calls.subscription = { key, region };
      return new SpeechConfig();
    }
    setProperty(name, value) {
      this.properties[name] = value;
    }
  }
  class SpeechRecognizer {
    constructor(config, audio, autoDetect = null) {
      this.config = config;
      this.audio = audio;
      this.autoDetect = autoDetect;
      calls.recognizer = this;
    }
    static FromConfig(config, autoDetect, audio) {
      return new SpeechRecognizer(config, audio, autoDetect);
    }
    startContinuousRecognitionAsync(ok, fail) {
      if (startFails) fail("refused");
      else ok();
    }
    stopContinuousRecognitionAsync(ok) {
      ok();
    }
    close() {}
  }
  const sdk = {
    SpeechConfig,
    SpeechRecognizer,
    PropertyId: { SpeechServiceConnection_LanguageIdMode: "LanguageIdMode" },
    AutoDetectSourceLanguageConfig: { fromLanguages: (languages) => ({ languages }) },
    AudioStreamFormat: { getWaveFormatPCM: (rate, bits, channels) => ({ rate, bits, channels }) },
    AudioInputStream: {
      createPushStream: (format) => ({
        format,
        write: (bytes) => calls.written.push(Buffer.from(bytes)),
        close: () => {
          calls.closed = true;
          setImmediate(() => calls.recognizer.sessionStopped?.());
        },
      }),
    },
    AudioConfig: { fromStreamInput: (stream) => ({ stream }) },
    ResultReason: { RecognizedSpeech: 3 },
    CancellationReason: { Error: 1, EndOfStream: 2 },
    CancellationErrorCode: { 1: "AuthenticationFailure" },
  };
  return { sdk, calls };
}

async function connected(options = {}, sdkOptions) {
  const { MaiSpeechStreaming } = await load();
  const { sdk, calls } = makeFakeSdk(sdkOptions);
  const streaming = new MaiSpeechStreaming(() => sdk);
  await streaming.connect({
    apiKey: "ms-key",
    endpoint: "https://acme.services.ai.azure.com",
    sampleRate: 24000,
    ...options,
  });
  return { streaming, calls };
}

test("connects to the resource with the MAI streaming model and 24 kHz PCM", async () => {
  const { streaming, calls } = await connected({ language: "fr" });
  assert.deepEqual(calls.endpoint, { url: "https://acme.services.ai.azure.com/", key: "ms-key" });
  assert.equal(calls.recognizer.config.model, "mai-transcribe-2-streaming");
  assert.equal(calls.recognizer.config.speechRecognitionLanguage, "fr-FR");
  assert.deepEqual(calls.recognizer.audio.stream.format, { rate: 24000, bits: 16, channels: 1 });
  assert.equal(streaming.isConnected, true);
});

test("a bare region connects by subscription, and a foreign host never gets the key", async () => {
  const { calls } = await connected({ endpoint: "swedencentral" });
  assert.deepEqual(calls.subscription, { key: "ms-key", region: "swedencentral" });

  const { MaiSpeechStreaming } = await load();
  const fake = makeFakeSdk();
  const streaming = new MaiSpeechStreaming(() => fake.sdk);
  await assert.rejects(
    streaming.connect({ apiKey: "ms-key", endpoint: "https://evil.example.com" }),
    /resource address, or a region/
  );
  assert.equal(fake.calls.endpoint, null);
});

test("auto language detects among the app's languages instead of assuming English", async () => {
  const { calls } = await connected({ language: "auto" });
  assert.equal(calls.recognizer.config.speechRecognitionLanguage, undefined);
  assert.ok(calls.recognizer.autoDetect.languages.includes("fr-FR"));
  assert.equal(calls.recognizer.config.properties.LanguageIdMode, "Continuous");
});

test("partials and finals reach the meeting pipeline with a timestamp from the offset", async () => {
  const { streaming, calls } = await connected({ language: "fr" });
  const partials = [];
  const finals = [];
  streaming.onPartialTranscript = (text) => partials.push(text);
  streaming.onFinalTranscript = (text, startedAt) => finals.push({ text, startedAt });
  calls.recognizer.recognizing(null, { result: { text: "Bonjour" } });
  calls.recognizer.recognized(null, {
    result: { reason: 3, text: "Bonjour à tous.", offset: 15_000_000 },
  });
  assert.deepEqual(partials, ["Bonjour"]);
  assert.equal(finals[0].text, "Bonjour à tous.");
  assert.equal(finals[0].startedAt, streaming.sessionStartedAt + 1500);
  assert.deepEqual(streaming.completedSegments, ["Bonjour à tous."]);
});

test("audio is written as-is, and disconnect closes the stream and returns the text", async () => {
  const { streaming, calls } = await connected({ language: "fr" });
  assert.equal(streaming.sendAudio(Buffer.from([1, 2, 3, 4])), true);
  assert.deepEqual(calls.written, [Buffer.from([1, 2, 3, 4])]);
  calls.recognizer.recognized(null, { result: { reason: 3, text: "Fin.", offset: 0 } });
  const result = await streaming.disconnect();
  assert.equal(calls.closed, true);
  assert.deepEqual(result, { text: "Fin." });
  assert.equal(streaming.isConnected, false);
  assert.equal(streaming.sendAudio(Buffer.from([1])), false);
});

test("a service error is shown once and starts the meeting's recovery", async () => {
  const { streaming, calls } = await connected({ language: "fr" });
  const errors = [];
  const lost = [];
  streaming.onError = (error) => errors.push(error.message);
  streaming.onConnectionLost = (error) => lost.push(error.message);
  const cancel = () =>
    calls.recognizer.canceled(null, { reason: 1, errorCode: 1, errorDetails: "bad key" });
  cancel();
  cancel();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /AuthenticationFailure/);
  assert.equal(lost.length, 1);
});

test("a start the service refuses rejects connect and leaves nothing open", async () => {
  await assert.rejects(connected({ language: "fr" }, { startFails: true }), /could not start/);
});
