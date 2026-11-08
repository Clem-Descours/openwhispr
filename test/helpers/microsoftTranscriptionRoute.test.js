const test = require("node:test");
const assert = require("node:assert/strict");

const loadRoute = () => import("../../src/helpers/transcriptionRoute.ts");
const loadRegistry = () => import("../../src/models/registryData.js");
const loadFork = () => import("../../src/models/forkProviders.js");

test("the fork's Microsoft provider is merged into the active catalog", async () => {
  const { getRegistryData } = await loadRegistry();
  const provider = getRegistryData().transcriptionProviders.find((p) => p.id === "microsoft");
  assert.ok(provider, "microsoft provider missing from the catalog");
  assert.equal(provider.defaultModel, "MAI-Transcribe-2");
  assert.ok(provider.models.some((m) => m.id === "MAI-Transcribe-2"));
});

test("a downloaded catalog keeps the overlay, and an upstream entry with the same id wins", async () => {
  const { withForkProviders } = await loadFork();
  const merged = withForkProviders({ transcriptionProviders: [{ id: "openai", models: [] }] });
  assert.deepEqual(
    merged.transcriptionProviders.map((p) => p.id),
    ["openai", "microsoft"]
  );
  const upstream = { id: "microsoft", name: "Upstream", models: [] };
  const untouched = withForkProviders({ transcriptionProviders: [upstream] });
  assert.equal(untouched.transcriptionProviders.length, 1);
  assert.equal(untouched.transcriptionProviders[0].name, "Upstream");
});

test("every offered MAI model survives the resolver and unknown ones fall back to MAI-Transcribe-2", async () => {
  const { resolveByokModel } = await loadRoute();
  const { FORK_TRANSCRIPTION_PROVIDERS } = await loadFork();
  const provider = FORK_TRANSCRIPTION_PROVIDERS.find((p) => p.id === "microsoft");
  for (const model of provider.models) {
    assert.equal(resolveByokModel("microsoft", model.id), model.id);
  }
  assert.equal(resolveByokModel("microsoft", "gpt-transcribe"), "MAI-Transcribe-2");
  assert.equal(resolveByokModel("microsoft", ""), "MAI-Transcribe-2");
});

test("Microsoft routes through the main-process proxy with language and no endpoint", async () => {
  const { resolveTranscriptionRoute, byokFileSizeLimit } = await loadRoute();
  const route = resolveTranscriptionRoute({
    settings: {
      cloudTranscriptionProvider: "microsoft",
      cloudTranscriptionModel: "MAI-Transcribe-2",
      preferredLanguage: "fr-FR",
    },
  });
  assert.equal(route.transport, "proxied");
  assert.equal(route.provider, "microsoft");
  assert.equal(route.model, "MAI-Transcribe-2");
  assert.equal(route.language, "fr");
  assert.equal(route.endpoint, undefined, "the endpoint must stay in main");
  assert.equal(route.sizeCapBytes, byokFileSizeLimit("microsoft"));
  assert.ok(byokFileSizeLimit("microsoft") > byokFileSizeLimit("openai"));
});
