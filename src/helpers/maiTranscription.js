const debugLogger = require("./debugLogger");
const {
  PROVIDER_ERROR_CODES,
  providerHttpError,
  providerError,
  redactProviderBody,
} = require("./providerHttpErrors");

// Microsoft AI's MAI-Transcribe models are served by the Azure Speech Fast
// Transcription API in "enhanced mode": same endpoint as classic fast
// transcription, the model is picked by `definition.enhancedMode.model`.
// https://learn.microsoft.com/azure/ai-services/speech-service/mai-transcribe
const MAI_API_VERSION = "2025-10-15";
const MAI_DEFAULT_MODEL = "MAI-Transcribe-2";
const MAI_PROVIDER_NAME = "Microsoft";

// The key is only ever sent to Microsoft's own Speech hosts. A typo or a pasted
// third-party URL must fail closed instead of leaking the subscription key.
const ALLOWED_HOST_SUFFIXES = [
  ".cognitiveservices.azure.com", // resource endpoint (custom subdomain)
  ".api.cognitive.microsoft.com", // regional endpoint
  ".services.ai.azure.com", // Microsoft Foundry resource endpoint
];

// Regions that serve MAI-Transcribe ("LLM speech" tab of the regions page).
// Only used to let users type a bare region name instead of a URL.
const REGION_PATTERN = /^[a-z]+[a-z0-9]*$/;

// The API decodes WAV, MP3 and FLAC only. Chromium records WebM/Opus, so
// anything else is re-encoded before upload.
const ACCEPTED_CONTAINERS = new Set(["wav", "mp3", "flac"]);

// Terms are hints, not forced output; keep the request small and bounded.
const MAX_PHRASES = 100;
const MAX_PHRASE_LENGTH = 50;

function normalizeSpeechEndpoint(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return null;

  if (REGION_PATTERN.test(raw)) {
    return `https://${raw}.api.cognitive.microsoft.com`;
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host !== suffix.slice(1))) {
    return null;
  }
  // Users paste the full transcribe URL or the bare resource URL; the origin is
  // all that identifies the resource.
  return url.origin;
}

function buildTranscribeUrl(endpoint) {
  const origin = normalizeSpeechEndpoint(endpoint);
  if (!origin) return null;
  return `${origin}/speechtotext/transcriptions:transcribe?api-version=${MAI_API_VERSION}`;
}

function sanitizePhrases(phrases) {
  if (!Array.isArray(phrases)) return [];
  const seen = new Set();
  const out = [];
  for (const phrase of phrases) {
    if (typeof phrase !== "string") continue;
    const value = phrase.trim().slice(0, MAX_PHRASE_LENGTH);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= MAX_PHRASES) break;
  }
  return out;
}

function buildDefinition({ model, language, phrases, diarize, timestamps, style } = {}) {
  const modelOptions = {};
  if (style === "clean" || style === "verbatim") modelOptions.transcribeStyle = style;
  if (timestamps) modelOptions.timestamps = "segment";

  const definition = {
    enhancedMode: {
      enabled: true,
      model: model || MAI_DEFAULT_MODEL,
      ...(Object.keys(modelOptions).length > 0 ? { modelOptions } : {}),
    },
  };
  // Bare language code ("fr", not "fr-FR"), one language only. Auto-detection
  // is the API default, so "auto" sends nothing.
  if (language && language !== "auto") {
    definition.locales = [String(language).split("-")[0].toLowerCase()];
  }
  const cleanPhrases = sanitizePhrases(phrases);
  if (cleanPhrases.length > 0) definition.phraseList = { phrases: cleanPhrases };
  if (diarize) definition.diarization = { enabled: true };
  return definition;
}

function sniffAudioContainer(buffer) {
  if (!buffer || buffer.length < 4) return null;
  const ascii = (start, end) => buffer.subarray(start, end).toString("latin1");
  if (buffer.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "wav";
  if (ascii(0, 4) === "fLaC") return "flac";
  if (ascii(0, 3) === "ID3") return "mp3";
  // MPEG audio frame sync (11 set bits), layer III.
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0 && (buffer[1] & 0x06) === 0x02) {
    return "mp3";
  }
  return null;
}

const CONTENT_TYPES = { wav: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac" };

// Fast transcription returns one combinedPhrases entry per channel and a
// phrases array with timings in milliseconds (and `speaker` when diarized).
function parseTranscribeResponse(data) {
  const combined = Array.isArray(data?.combinedPhrases) ? data.combinedPhrases : [];
  const phrases = Array.isArray(data?.phrases) ? data.phrases : [];
  let text = combined
    .map((entry) => (typeof entry?.text === "string" ? entry.text.trim() : ""))
    .filter(Boolean)
    .join("\n");
  if (!text) {
    text = phrases
      .map((p) => (typeof p?.text === "string" ? p.text.trim() : ""))
      .filter(Boolean)
      .join(" ");
  }

  const segments = [];
  for (const phrase of phrases) {
    const segText = typeof phrase?.text === "string" ? phrase.text.trim() : "";
    if (!segText || !Number.isFinite(phrase.offsetMilliseconds)) continue;
    const start = Math.max(0, phrase.offsetMilliseconds) / 1000;
    const duration = Number.isFinite(phrase.durationMilliseconds)
      ? Math.max(0, phrase.durationMilliseconds)
      : 0;
    const segment = { text: segText, start, end: start + duration / 1000 };
    if (phrase.speaker !== undefined && phrase.speaker !== null) {
      segment.speaker = `Speaker ${phrase.speaker}`;
    }
    segments.push(segment);
  }

  return {
    text,
    segments,
    durationMs: Number.isFinite(data?.durationMilliseconds) ? data.durationMilliseconds : null,
  };
}

function isLocaleRejection(status, body) {
  return status === 400 && /locale/i.test(body || "");
}

async function prepareAudio(audioBuffer, convertToWav) {
  const buffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
  const container = sniffAudioContainer(buffer);
  if (container && ACCEPTED_CONTAINERS.has(container)) {
    return { buffer, contentType: CONTENT_TYPES[container], fileName: `audio.${container}` };
  }
  if (typeof convertToWav !== "function") {
    throw new Error("MAI-Transcribe accepts WAV, MP3 or FLAC audio only");
  }
  const wav = await convertToWav(buffer);
  return { buffer: wav, contentType: "audio/wav", fileName: "audio.wav" };
}

async function transcribeWithMai(
  {
    audioBuffer,
    apiKey,
    endpoint,
    model,
    language,
    phrases,
    diarize = false,
    timestamps = false,
    style,
    signal,
    convertToWav,
  },
  fetchImpl
) {
  if (!apiKey?.trim()) {
    throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
      provider: MAI_PROVIDER_NAME,
      surface: "transcription",
    });
  }
  const url = buildTranscribeUrl(endpoint);
  if (!url) {
    throw Object.assign(
      new Error(
        "Microsoft Speech endpoint is missing or invalid. Use your resource endpoint " +
          "(https://<name>.cognitiveservices.azure.com) or a region such as northeurope."
      ),
      { code: "MAI_ENDPOINT_INVALID" }
    );
  }

  const audio = await prepareAudio(audioBuffer, convertToWav);
  const resolvedModel = model || MAI_DEFAULT_MODEL;
  // Electron's net stack honours the system proxy; required lazily so the
  // pure helpers above stay testable outside Electron.
  const doFetch =
    fetchImpl ||
    ((u, init) => require("electron").net.fetch(u, { ...init, useSessionCookies: false }));

  const send = async (definition) => {
    const form = new FormData();
    form.append("audio", new Blob([audio.buffer], { type: audio.contentType }), audio.fileName);
    form.append("definition", JSON.stringify(definition));
    return doFetch(url, {
      method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": apiKey.trim() },
      body: form,
      ...(signal ? { signal } : {}),
    });
  };

  const definition = buildDefinition({
    model: resolvedModel,
    language,
    phrases,
    diarize,
    timestamps: timestamps || diarize,
    style,
  });

  debugLogger.debug(
    "MAI-Transcribe request",
    {
      model: resolvedModel,
      language: definition.locales?.[0] ?? "auto",
      phrases: definition.phraseList?.phrases.length ?? 0,
      diarize: !!diarize,
      audioBytes: audio.buffer.length,
      contentType: audio.contentType,
    },
    "transcription"
  );

  let response = await send(definition);
  if (!response.ok && definition.locales) {
    // A dictation language MAI does not cover: retry once with auto-detection
    // rather than failing the dictation.
    const body = await response.text().catch(() => "");
    if (isLocaleRejection(response.status, body)) {
      debugLogger.warn("MAI-Transcribe rejected the locale; retrying with auto-detect", {
        locale: definition.locales[0],
      });
      const { locales: _dropped, ...withoutLocale } = definition;
      response = await send(withoutLocale);
    } else {
      throw maiHttpError(response, body, resolvedModel);
    }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw maiHttpError(response, body, resolvedModel);
  }

  const parsed = parseTranscribeResponse(await response.json());
  return { ...parsed, model: resolvedModel };
}

function maiHttpError(response, body, model) {
  debugLogger.warn("MAI-Transcribe failed", {
    status: response.status,
    body: redactProviderBody(body),
  });
  return providerHttpError({
    provider: MAI_PROVIDER_NAME,
    model,
    status: response.status,
    body,
    headers: response.headers,
    surface: "transcription",
  });
}

module.exports = {
  MAI_API_VERSION,
  MAI_DEFAULT_MODEL,
  normalizeSpeechEndpoint,
  buildTranscribeUrl,
  buildDefinition,
  sanitizePhrases,
  sniffAudioContainer,
  parseTranscribeResponse,
  transcribeWithMai,
};
