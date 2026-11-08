const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeSpeechEndpoint,
  buildTranscribeUrl,
  buildDefinition,
  sniffAudioContainer,
  parseTranscribeResponse,
  transcribeWithMai,
} = require("../../src/helpers/maiTranscription");

const WAV = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVE"),
  Buffer.alloc(32),
]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
const ENDPOINT = "https://contoso.cognitiveservices.azure.com";
const TRANSCRIBE_URL = `${ENDPOINT}/speechtotext/transcriptions:transcribe?api-version=2025-10-15`;

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function recordingFetch(...responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, definition: JSON.parse(init.body.get("definition")) });
    return responses.shift();
  };
  return { fetchImpl, calls };
}

test("endpoint: accepts resource, regional and Foundry hosts, keeps only the origin", () => {
  assert.equal(normalizeSpeechEndpoint(`${ENDPOINT}/`), ENDPOINT);
  assert.equal(normalizeSpeechEndpoint(TRANSCRIBE_URL), ENDPOINT);
  assert.equal(
    normalizeSpeechEndpoint("https://northeurope.api.cognitive.microsoft.com"),
    "https://northeurope.api.cognitive.microsoft.com"
  );
  assert.equal(
    normalizeSpeechEndpoint("https://my-hub.services.ai.azure.com/"),
    "https://my-hub.services.ai.azure.com"
  );
});

test("endpoint: a bare region expands to the regional host", () => {
  assert.equal(
    normalizeSpeechEndpoint(" northeurope "),
    "https://northeurope.api.cognitive.microsoft.com"
  );
});

test("endpoint: never sends the key to a foreign, look-alike or plain-HTTP host", () => {
  for (const bad of [
    "",
    "https://evil.example.com",
    "https://cognitiveservices.azure.com.evil.com",
    "https://evilcognitiveservices.azure.com",
    "http://contoso.cognitiveservices.azure.com",
    "https://user:pass@contoso.cognitiveservices.azure.com",
    "not a url",
  ]) {
    assert.equal(normalizeSpeechEndpoint(bad), null, bad);
  }
  assert.equal(buildTranscribeUrl("https://evil.example.com"), null);
});

test("definition: enhanced mode with MAI-Transcribe-2 by default, auto language sends no locale", () => {
  assert.deepEqual(buildDefinition({ language: "auto" }), {
    enhancedMode: { enabled: true, model: "MAI-Transcribe-2" },
  });
});

test("definition: bare locale, deduplicated bounded phrase list, diarization and timestamps", () => {
  const phrases = ["Contoso", "contoso", " Rehaan ", "", 42, "x".repeat(80)];
  const def = buildDefinition({
    model: "MAI-Transcribe-1.5",
    language: "fr-FR",
    phrases,
    diarize: true,
    timestamps: true,
    style: "clean",
  });
  assert.deepEqual(def.enhancedMode, {
    enabled: true,
    model: "MAI-Transcribe-1.5",
    modelOptions: { transcribeStyle: "clean", timestamps: "segment" },
  });
  assert.deepEqual(def.locales, ["fr"]);
  assert.deepEqual(def.phraseList.phrases, ["Contoso", "Rehaan", "x".repeat(50)]);
  assert.deepEqual(def.diarization, { enabled: true });

  const many = buildDefinition({ phrases: Array.from({ length: 150 }, (_, i) => `t${i}`) });
  assert.equal(many.phraseList.phrases.length, 100);
});

test("container sniffing recognises WAV, FLAC and MP3, not WebM", () => {
  assert.equal(sniffAudioContainer(WAV), "wav");
  assert.equal(sniffAudioContainer(Buffer.from("fLaC\0\0\0\0")), "flac");
  assert.equal(sniffAudioContainer(Buffer.from("ID3\x04\0\0")), "mp3");
  assert.equal(sniffAudioContainer(Buffer.from([0xff, 0xfb, 0x90, 0x00])), "mp3");
  assert.equal(sniffAudioContainer(WEBM), null);
});

test("response parsing joins channels and maps phrases to seconds with speakers", () => {
  const parsed = parseTranscribeResponse({
    durationMilliseconds: 4200,
    combinedPhrases: [{ text: "Bonjour à tous. Merci." }],
    phrases: [
      { offsetMilliseconds: 0, durationMilliseconds: 1500, text: "Bonjour à tous.", speaker: 1 },
      { offsetMilliseconds: 2000, durationMilliseconds: 800, text: "Merci.", speaker: 2 },
      { offsetMilliseconds: 3000, text: "  " },
    ],
  });
  assert.equal(parsed.text, "Bonjour à tous. Merci.");
  assert.equal(parsed.durationMs, 4200);
  assert.deepEqual(parsed.segments, [
    { text: "Bonjour à tous.", start: 0, end: 1.5, speaker: "Speaker 1" },
    { text: "Merci.", start: 2, end: 2.8, speaker: "Speaker 2" },
  ]);
});

test("transcribe: posts multipart audio + definition with the subscription key header", async () => {
  const { fetchImpl, calls } = recordingFetch(
    response(200, { combinedPhrases: [{ text: "hello world" }], phrases: [] })
  );
  const result = await transcribeWithMai(
    {
      audioBuffer: WAV,
      apiKey: " k1 ",
      endpoint: ENDPOINT,
      language: "en",
      phrases: ["OpenWhispr"],
    },
    fetchImpl
  );

  assert.equal(result.text, "hello world");
  assert.equal(result.model, "MAI-Transcribe-2");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TRANSCRIBE_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, { "Ocp-Apim-Subscription-Key": "k1" });
  const audio = calls[0].init.body.get("audio");
  assert.equal(audio.type, "audio/wav");
  assert.equal(audio.name, "audio.wav");
  assert.deepEqual(calls[0].definition.locales, ["en"]);
  assert.deepEqual(calls[0].definition.phraseList, { phrases: ["OpenWhispr"] });
});

test("transcribe: WebM recordings are re-encoded before upload", async () => {
  const { fetchImpl, calls } = recordingFetch(response(200, { combinedPhrases: [{ text: "ok" }] }));
  let converted = 0;
  await transcribeWithMai(
    {
      audioBuffer: WEBM,
      apiKey: "k",
      endpoint: "northeurope",
      convertToWav: async (buffer) => {
        converted += 1;
        assert.deepEqual(buffer, WEBM);
        return WAV;
      },
    },
    fetchImpl
  );
  assert.equal(converted, 1);
  assert.equal(calls[0].init.body.get("audio").type, "audio/wav");
  assert.match(calls[0].url, /^https:\/\/northeurope\.api\.cognitive\.microsoft\.com\//);
});

test("transcribe: a rejected locale retries once with auto-detection", async () => {
  const { fetchImpl, calls } = recordingFetch(
    response(400, { error: { code: "InvalidArgument", message: "Locale 'xx' is not supported" } }),
    response(200, { combinedPhrases: [{ text: "salut" }] })
  );
  const result = await transcribeWithMai(
    { audioBuffer: WAV, apiKey: "k", endpoint: ENDPOINT, language: "xx" },
    fetchImpl
  );
  assert.equal(result.text, "salut");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].definition.locales, ["xx"]);
  assert.equal(calls[1].definition.locales, undefined);
});

test("transcribe: auth failures surface as classified provider errors without a retry", async () => {
  const { fetchImpl, calls } = recordingFetch(response(401, { error: { code: "401" } }));
  await assert.rejects(
    transcribeWithMai(
      { audioBuffer: WAV, apiKey: "bad", endpoint: ENDPOINT, language: "fr" },
      fetchImpl
    ),
    (error) => {
      assert.equal(error.code, "PROVIDER_AUTH_FAILED");
      return true;
    }
  );
  assert.equal(calls.length, 1);
});

test("transcribe: missing key or invalid endpoint fail before any request", async () => {
  const { fetchImpl, calls } = recordingFetch();
  await assert.rejects(
    transcribeWithMai({ audioBuffer: WAV, apiKey: "", endpoint: ENDPOINT }, fetchImpl),
    (error) => error.code === "PROVIDER_KEY_MISSING" || /key/i.test(error.message)
  );
  await assert.rejects(
    transcribeWithMai(
      { audioBuffer: WAV, apiKey: "k", endpoint: "https://evil.example.com" },
      fetchImpl
    ),
    { code: "MAI_ENDPOINT_INVALID" }
  );
  assert.equal(calls.length, 0);
});
