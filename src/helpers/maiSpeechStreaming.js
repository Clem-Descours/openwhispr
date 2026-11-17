const debugLogger = require("./debugLogger");
const { normalizeSpeechEndpoint } = require("./maiTranscription");

// Live note recording with Microsoft's MAI-Transcribe-2-Streaming, through the
// Azure Speech SDK. Unlike the Realtime API, the SDK needs no Foundry model
// deployment (and so no deployment quota): a Speech or Foundry resource key in a
// region that serves the model is enough.
// https://learn.microsoft.com/azure/ai-services/speech-service/mai-transcribe-2-streaming-speech-sdk
const MAI_STREAMING_MODEL = "mai-transcribe-2-streaming";
const CONNECT_TIMEOUT_MS = 15000;
const DRAIN_TIMEOUT_MS = 5000;
const REGION_PATTERN = /^[a-z]+[a-z0-9]*$/;

// The SDK wants a full locale; the app stores a bare language code.
const LOCALES = {
  ar: "ar-SA",
  ca: "ca-ES",
  cs: "cs-CZ",
  da: "da-DK",
  de: "de-DE",
  el: "el-GR",
  en: "en-US",
  es: "es-ES",
  fi: "fi-FI",
  fr: "fr-FR",
  he: "he-IL",
  hi: "hi-IN",
  hu: "hu-HU",
  id: "id-ID",
  it: "it-IT",
  ja: "ja-JP",
  ko: "ko-KR",
  nb: "nb-NO",
  nl: "nl-NL",
  no: "nb-NO",
  pl: "pl-PL",
  pt: "pt-BR",
  ro: "ro-RO",
  ru: "ru-RU",
  sv: "sv-SE",
  th: "th-TH",
  tr: "tr-TR",
  uk: "uk-UA",
  vi: "vi-VN",
  zh: "zh-CN",
};

// With no language set, the SDK assumes en-US and garbles everything else, so
// "auto" detects among the app's own languages (continuous detection takes 10 at most).
const AUTO_DETECT_LOCALES = [
  "en-US",
  "fr-FR",
  "de-DE",
  "es-ES",
  "it-IT",
  "pt-BR",
  "ru-RU",
  "zh-CN",
];

function localeFor(language) {
  const code = typeof language === "string" ? language.trim().toLowerCase().split("-")[0] : "";
  return LOCALES[code] || null;
}

// The key only ever goes to Microsoft: a region name, or an allowlisted Speech host.
function speechConfigFor(sdk, { apiKey, endpoint }) {
  const raw = typeof endpoint === "string" ? endpoint.trim() : "";
  if (REGION_PATTERN.test(raw)) return sdk.SpeechConfig.fromSubscription(apiKey, raw);
  const origin = normalizeSpeechEndpoint(raw);
  if (!origin) return null;
  return sdk.SpeechConfig.fromEndpoint(new URL(origin), apiKey);
}

class MaiSpeechStreaming {
  constructor(loadSdk = () => require("microsoft-cognitiveservices-speech-sdk")) {
    this._loadSdk = loadSdk;
    this.providerLabel = "Microsoft AI Speech";
    this.isConnected = false;
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;
    this.onConnectionLost = null;
    this.completedSegments = [];
    this.sessionStartedAt = null;
    this.audioBytesSent = 0;
    this.streamLabel = null;
    this._recognizer = null;
    this._pushStream = null;
    this._disconnecting = false;
    this._errorReported = false;
    this._drained = null;
  }

  async connect(options = {}) {
    const { apiKey, endpoint, language, streamLabel } = options;
    if (!apiKey) throw new Error("No Microsoft AI key configured. Add your key in Settings.");
    if (this.isConnected || this._recognizer) return;

    const sdk = this._loadSdk();
    const speechConfig = speechConfigFor(sdk, { apiKey, endpoint });
    if (!speechConfig) {
      throw new Error(
        "The Microsoft AI endpoint must be an Azure Speech or Foundry resource address, or a region."
      );
    }
    speechConfig.model = MAI_STREAMING_MODEL;

    const sampleRate = options.sampleRate || 24000;
    this.streamLabel = streamLabel || null;
    this.completedSegments = [];
    this.audioBytesSent = 0;
    this._errorReported = false;
    this._disconnecting = false;

    const locale = localeFor(language);
    let autoDetect = null;
    if (locale) {
      speechConfig.speechRecognitionLanguage = locale;
    } else {
      speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_LanguageIdMode, "Continuous");
      autoDetect = sdk.AutoDetectSourceLanguageConfig.fromLanguages(AUTO_DETECT_LOCALES);
    }

    this._pushStream = sdk.AudioInputStream.createPushStream(
      sdk.AudioStreamFormat.getWaveFormatPCM(sampleRate, 16, 1)
    );
    const audioConfig = sdk.AudioConfig.fromStreamInput(this._pushStream);
    const recognizer = autoDetect
      ? sdk.SpeechRecognizer.FromConfig(speechConfig, autoDetect, audioConfig)
      : new sdk.SpeechRecognizer(speechConfig, audioConfig);
    this._recognizer = recognizer;

    let resolveDrained;
    this._drained = new Promise((resolve) => {
      resolveDrained = resolve;
    });

    recognizer.recognizing = (_, event) => {
      const text = event.result?.text?.trim();
      if (text) this.onPartialTranscript?.(text);
    };
    recognizer.recognized = (_, event) => {
      if (event.result?.reason !== sdk.ResultReason.RecognizedSpeech) return;
      const text = event.result.text?.trim();
      if (!text) return;
      this.completedSegments.push(text);
      // Offsets are 100 ns ticks from the first sample written to the stream.
      const startedAt =
        this.sessionStartedAt != null && Number.isFinite(event.result.offset)
          ? this.sessionStartedAt + event.result.offset / 10000
          : Date.now();
      this.onFinalTranscript?.(this.getFullTranscript(), startedAt);
    };
    recognizer.sessionStopped = () => resolveDrained();
    recognizer.canceled = (_, event) => {
      resolveDrained();
      if (event.reason !== sdk.CancellationReason.Error) return;
      const code = sdk.CancellationErrorCode[event.errorCode] || event.errorCode;
      const error = new Error(
        `Microsoft AI couldn't transcribe the audio (${code}): ${event.errorDetails || "no details"}`
      );
      debugLogger.warn(`${this.providerLabel} canceled`, this._logContext({ code }));
      if (this._disconnecting) return;
      const wasConnected = this.isConnected;
      this.isConnected = false;
      if (!this._errorReported) {
        this._errorReported = true;
        this.onError?.(error);
      }
      if (wasConnected) this.onConnectionLost?.(error);
    };

    debugLogger.debug(
      `${this.providerLabel} connecting`,
      this._logContext({ locale: locale || "auto", sampleRate })
    );

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${this.providerLabel} connection timeout`));
      }, CONNECT_TIMEOUT_MS);
      recognizer.startContinuousRecognitionAsync(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (err) => {
          clearTimeout(timer);
          reject(new Error(`${this.providerLabel} could not start: ${err}`));
        }
      );
    }).catch((error) => {
      this.cleanup();
      throw error;
    });

    this.sessionStartedAt = Date.now();
    this.isConnected = true;
    debugLogger.debug(`${this.providerLabel} session started`, this._logContext());
  }

  sendAudio(pcmBuffer) {
    if (!this._pushStream || !this.isConnected) return false;
    const buffer = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer);
    if (!buffer.length) return true;
    // The SDK keeps a reference: hand it its own copy of the bytes.
    const copy = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    this._pushStream.write(copy);
    this.audioBytesSent += buffer.length;
    return true;
  }

  getFullTranscript() {
    return this.completedSegments.join(" ");
  }

  // Closing the stream makes the service finalize what it has heard; the last
  // results arrive before the session stops.
  async disconnect() {
    const recognizer = this._recognizer;
    if (!recognizer) {
      this.cleanup();
      return { text: this.getFullTranscript() };
    }
    this._disconnecting = true;
    try {
      this._pushStream?.close();
    } catch {}
    let timer;
    await Promise.race([
      this._drained,
      new Promise((resolve) => {
        timer = setTimeout(resolve, DRAIN_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    await new Promise((resolve) => {
      try {
        recognizer.stopContinuousRecognitionAsync(resolve, resolve);
      } catch {
        resolve();
      }
    });
    const result = { text: this.getFullTranscript() };
    this.onSessionEnd?.(result);
    this.cleanup();
    return result;
  }

  cleanup() {
    this.isConnected = false;
    if (this._recognizer) {
      try {
        this._recognizer.close();
      } catch {}
    }
    this._recognizer = null;
    this._pushStream = null;
    this._disconnecting = false;
  }

  _logContext(extra = {}) {
    return { ...(this.streamLabel ? { stream: this.streamLabel } : {}), ...extra };
  }
}

module.exports = { MaiSpeechStreaming, MAI_STREAMING_MODEL, localeFor };
