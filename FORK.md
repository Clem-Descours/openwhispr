# Fork: MAI-Transcribe-2 support

This fork of [OpenWhispr](https://github.com/OpenWhispr/openwhispr) adds **Microsoft AI** as a
cloud (BYOK) transcription provider, using Microsoft's `MAI-Transcribe-2` model (and
`MAI-Transcribe-1.5`) through the Azure Speech Fast Transcription API.

## Setup

1. In Azure (or Microsoft Foundry), create a **Speech** or **Foundry** resource in a region that
   serves MAI-Transcribe (for the EU: `northeurope`; otherwise `eastus`, `westus`, `westus2`,
   `centralindia`, `southeastasia`).
2. Copy **Key 1** and the **Endpoint** from the resource's "Keys and Endpoint" page.
3. In OpenWhispr: Settings → Speech to text → Cloud → **Microsoft AI**. Paste the key, then the
   endpoint (`https://<resource>.cognitiveservices.azure.com`) or just the region name
   (`northeurope`). Pick `MAI-Transcribe-2`.

The values can also be set in the `.env` file: `MICROSOFT_SPEECH_KEY` and
`MICROSOFT_SPEECH_ENDPOINT`.

## Live note recording

Note recording streams, so it uses `MAI-Transcribe-2-Streaming` instead of the batch model. It goes
through the Azure Speech SDK (`microsoft-cognitiveservices-speech-sdk`, `maiSpeechStreaming.js`),
which needs no Foundry model deployment and so no deployment quota. The Realtime API route
(`/mai/v1/realtime`) needs a deployment, which a new subscription often can't create (quota 0).

1. The resource must be in a region that serves the streaming model: `swedencentral`, `eastus2`,
   `centralus` or `southeastasia`. MAI-Transcribe-2 (dictation) is served elsewhere
   (`northeurope`, `westeurope`, …), so no European region has both.
2. Settings → Note Recording → Microsoft AI: fill "Note recording key" and "Note recording
   endpoint" with that resource (endpoint URL or region name). Blank uses the main pair.
3. Pick `MAI-Transcribe-2-Streaming`.

The app language is sent as a locale (`fr` → `fr-FR`); "auto" detects among the app's languages,
since the SDK otherwise assumes `en-US`.

## What works

| Surface                    | Status                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Dictation (hotkey)         | Yes, batch. Recordings (WebM/Opus) are re-encoded to 16 kHz WAV in the main process.                          |
| Custom dictionary          | Sent as MAI's `phraseList` (max 100 terms, 50 chars each).                                                    |
| Language                   | Sent as a bare locale (`fr`); auto-detect when "auto". A locale MAI rejects is retried once with auto-detect. |
| Audio file upload          | Yes, with native speaker diarization and segment timestamps.                                                  |
| Retry from history         | Yes.                                                                                                          |
| Live meeting transcription | Yes, with `MAI-Transcribe-2-Streaming` (preview) through the Speech SDK. See below.                           |
| Connection check           | Yes (Settings and onboarding): an empty request to the endpoint, so nothing is transcribed or billed.         |

## Design notes

- `src/helpers/maiTranscription.js`: request building, endpoint allowlist, WAV re-encode, response
  parsing. The key is only ever sent to `*.cognitiveservices.azure.com`,
  `*.api.cognitive.microsoft.com` or `*.services.ai.azure.com` over HTTPS.
- `src/models/forkProviders.js`: the provider is merged into the model catalog at load time instead
  of editing the vendored, signed `modelRegistryData.json`, so upstream catalog updates do not
  remove it and `npm run model-registry:verify` keeps passing.
- Key and endpoint are stored like every other BYOK secret (`src/config/secretKeys.js`) and read
  only by the main process; the renderer never passes a URL the key would be sent to.

## Staying in sync with upstream

```bash
git remote add upstream https://github.com/OpenWhispr/openwhispr.git
git fetch upstream
git rebase upstream/main   # or merge
```
