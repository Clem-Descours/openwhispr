const WebSocket = require("ws");
const { TinfoilRealtimeStreaming } = require("./tinfoilRealtimeStreaming");
const { buildRealtimeUrl } = require("./maiTranscription");
const debugLogger = require("./debugLogger");

// MAI-Transcribe-2-Streaming speaks the OpenAI Realtime transcription protocol,
// with the same constraint as Tinfoil's voxtral: no server-side speech detection,
// so the client commits each turn itself. Tinfoil's commit loop does exactly that.
// https://learn.microsoft.com/azure/ai-services/speech-service/mai-transcribe-2-streaming-realtime
//
// The model is addressed by its Foundry deployment name; deploying the model
// keeps its name unless the user renames it.
const MAI_REALTIME_MODEL = "MAI-Transcribe-2-Streaming";

const INTERMEDIATE_EVENT = "conversation.item.input_audio_transcription.intermediate";
const FAILED_EVENT = "conversation.item.input_audio_transcription.failed";

class MaiRealtimeStreaming extends TinfoilRealtimeStreaming {
  constructor(openSocket = (url, options) => new WebSocket(url, options)) {
    super();
    this._openSocket = openSocket;
    this.providerLabel = "Microsoft AI Realtime";
    this.pinsLanguage = true;
    this._failureReported = false;
  }

  async connect(options = {}) {
    const url = buildRealtimeUrl(options.endpoint);
    if (!url) {
      throw new Error(
        "Live note recording with Microsoft AI needs your Foundry resource endpoint " +
          "(https://<resource>.services.ai.azure.com), not a region. Update it in Settings."
      );
    }
    // The key only ever travels to the resource's own Foundry host (buildRealtimeUrl).
    this._createSocketImpl = ({ apiKey }) =>
      this._openSocket(url, { headers: { "api-key": apiKey } });
    return super.connect({ ...options, model: options.model || MAI_REALTIME_MODEL });
  }

  // "Only null is supported": a server_vad config is refused.
  turnDetection() {
    return null;
  }

  handleMessage(data) {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      super.handleMessage(data);
      return;
    }
    // MAI's provisional tail replaces the previous one and follows the finalized
    // deltas, so the live line is everything finalized plus the current guess.
    // What the service accepted: the deployment, rate and turn detection it will use.
    if (event.type === "session.updated") {
      const input = event.session?.audio?.input;
      debugLogger.debug(
        `${this.providerLabel} session accepted`,
        this._logContext({
          format: input?.format ?? null,
          transcriptionModel: input?.transcription?.model ?? null,
          language: input?.transcription?.language ?? null,
          turnDetection: input?.turn_detection ?? null,
        })
      );
    }
    // The base client only logs a failed turn. A Microsoft failure is usually the
    // setup (deployment name, region), so the first one is shown to the user.
    if (event.type === FAILED_EVENT) {
      debugLogger.warn(
        `${this.providerLabel} transcription failed`,
        this._logContext({
          code: event.error?.code ?? null,
          type: event.error?.type ?? null,
          param: event.error?.param ?? null,
          message: event.error?.message ?? null,
        })
      );
      if (!this._failureReported) {
        this._failureReported = true;
        this.onError?.(
          new Error(
            `Microsoft AI couldn't transcribe the audio${
              event.error?.code ? ` (${event.error.code})` : ""
            }. Check that ${this.model} is deployed under that exact name on the note recording resource.`
          )
        );
      }
    }
    if (event.type === INTERMEDIATE_EVENT) {
      const intermediate = typeof event.intermediate === "string" ? event.intermediate : "";
      const text = this.currentPartial + intermediate;
      if (text) this.onPartialTranscript?.(text);
      return;
    }
    super.handleMessage(data);
  }
}

module.exports = { MaiRealtimeStreaming, MAI_REALTIME_MODEL };
