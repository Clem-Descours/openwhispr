const WebSocket = require("ws");
const { TinfoilRealtimeStreaming } = require("./tinfoilRealtimeStreaming");
const { buildRealtimeUrl } = require("./maiTranscription");

// MAI-Transcribe-2-Streaming speaks the OpenAI Realtime transcription protocol,
// with the same constraint as Tinfoil's voxtral: no server-side speech detection,
// so the client commits each turn itself. Tinfoil's commit loop does exactly that.
// https://learn.microsoft.com/azure/ai-services/speech-service/mai-transcribe-2-streaming-realtime
//
// The model is addressed by its Foundry deployment name; deploying the model
// keeps its name unless the user renames it.
const MAI_REALTIME_MODEL = "MAI-Transcribe-2-Streaming";

const INTERMEDIATE_EVENT = "conversation.item.input_audio_transcription.intermediate";

class MaiRealtimeStreaming extends TinfoilRealtimeStreaming {
  constructor(openSocket = (url, options) => new WebSocket(url, options)) {
    super();
    this._openSocket = openSocket;
    this.providerLabel = "Microsoft AI Realtime";
    this.pinsLanguage = true;
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
