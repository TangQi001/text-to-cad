import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_IMAGE_GENERATION_SETTINGS,
  imageGenerationValidationError,
  normalizeImageGenerationSettings,
  readImageGenerationSettings,
  writeImageGenerationSettings
} from "./imageGenerationSettings.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values
  };
}

test("image generation settings normalize defaults", () => {
  assert.deepEqual(normalizeImageGenerationSettings({}), DEFAULT_IMAGE_GENERATION_SETTINGS);
});

test("image generation API key is session-only", () => {
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  writeImageGenerationSettings({
    baseUrl: "https://images.example/v1",
    apiKey: "secret-key",
    model: "image-model"
  }, { localStorage, sessionStorage });

  const persistentPayload = [...localStorage.values.values()].join("\n");
  assert.doesNotMatch(persistentPayload, /secret-key/);
  assert.match([...sessionStorage.values.values()].join("\n"), /secret-key/);
  assert.deepEqual(readImageGenerationSettings({ localStorage, sessionStorage }), {
    baseUrl: "https://images.example/v1",
    apiKey: "secret-key",
    model: "image-model"
  });
});

test("image generation validation reports missing fields and invalid URLs", () => {
  assert.match(imageGenerationValidationError({ baseUrl: "bad", apiKey: "key", model: "model", prompt: "prompt" }), /valid Base URL/);
  assert.match(imageGenerationValidationError({ baseUrl: "https://example.test/v1", model: "model", prompt: "prompt" }), /API key/);
  assert.match(imageGenerationValidationError({ baseUrl: "https://example.test/v1", apiKey: "key", model: "model" }), /Describe/);
  assert.equal(imageGenerationValidationError({ baseUrl: "https://example.test/v1", apiKey: "key", model: "model", prompt: "prompt" }), "");
});
