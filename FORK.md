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

## What works

| Surface                    | Status                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Dictation (hotkey)         | Yes, batch. Recordings (WebM/Opus) are re-encoded to 16 kHz WAV in the main process.                          |
| Custom dictionary          | Sent as MAI's `phraseList` (max 100 terms, 50 chars each).                                                    |
| Language                   | Sent as a bare locale (`fr`); auto-detect when "auto". A locale MAI rejects is retried once with auto-detect. |
| Audio file upload          | Yes, with native speaker diarization and segment timestamps.                                                  |
| Retry from history         | Yes.                                                                                                          |
| Live meeting transcription | No: `MAI-Transcribe-2` is batch only (`MAI-Transcribe-2-Streaming` is a separate realtime API).               |
| Settings connection check  | Not implemented; the first dictation validates the key and endpoint.                                          |

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
