// Fork-only catalog additions.
//
// Upstream ships its model catalog from the signed OpenWhispr/model-registry
// publication and refreshes it at runtime, so editing the vendored
// modelRegistryData.json would be both rejected by `model-registry:verify` and
// overwritten by the next catalog update. Instead, providers this fork adds are
// merged into whatever catalog is active (bundled or downloaded) when it is
// applied. If upstream ever publishes a provider with the same id, upstream's
// entry wins and this overlay steps aside.

export const FORK_TRANSCRIPTION_PROVIDERS = [
  {
    id: "microsoft",
    name: "Microsoft AI",
    defaultModel: "MAI-Transcribe-2",
    // Informational only: the real endpoint is per-resource (see maiTranscription.js).
    baseUrl: "https://cognitiveservices.azure.com",
    models: [
      {
        id: "MAI-Transcribe-2",
        name: "MAI-Transcribe-2",
        description: "Microsoft AI speech-to-text, 60 languages (preview)",
        descriptionKey: "models.descriptions.transcription.microsoft_mai_transcribe_2",
      },
      {
        id: "MAI-Transcribe-1.5",
        name: "MAI-Transcribe-1.5",
        description: "Previous MAI-Transcribe generation, 43 languages",
        descriptionKey: "models.descriptions.transcription.microsoft_mai_transcribe_1_5",
      },
    ],
  },
];

export function withForkProviders(catalog) {
  if (!catalog || !Array.isArray(catalog.transcriptionProviders)) return catalog;
  const existing = new Set(catalog.transcriptionProviders.map((provider) => provider?.id));
  const additions = FORK_TRANSCRIPTION_PROVIDERS.filter((provider) => !existing.has(provider.id));
  if (additions.length === 0) return catalog;
  return {
    ...catalog,
    transcriptionProviders: [...catalog.transcriptionProviders, ...structuredClone(additions)],
  };
}
