import assert from "node:assert/strict";
import test from "node:test";

import {
  ImageGenerationError,
  generateImageFromReference,
  imageEditsEndpoint
} from "./imageGeneration.mjs";

const VIEW_BYTES = Buffer.from("current-cad-view");
const OUTPUT_BYTES = Buffer.from("generated-image");

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("imageEditsEndpoint appends the OpenAI-compatible path once", () => {
  assert.equal(imageEditsEndpoint("https://api.example.test/v1"), "https://api.example.test/v1/images/edits");
  assert.equal(imageEditsEndpoint("https://api.example.test/v1/images/edits/"), "https://api.example.test/v1/images/edits");
  assert.throws(() => imageEditsEndpoint("file:///tmp/provider"), ImageGenerationError);
});

test("generateImageFromReference posts the current view as multipart and reads b64_json", async () => {
  const calls = [];
  const result = await generateImageFromReference({
    baseUrl: "https://api.example.test/v1",
    apiKey: "test-key",
    model: "image-model",
    prompt: "make this toy photorealistic",
    imageBase64: VIEW_BYTES.toString("base64"),
    imageMimeType: "image/png",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        data: [{
          b64_json: OUTPUT_BYTES.toString("base64"),
          revised_prompt: "refined prompt"
        }]
      });
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/v1/images/edits");
  assert.equal(calls[0].options.headers.authorization, "Bearer test-key");
  assert.equal(calls[0].options.body.get("model"), "image-model");
  assert.equal(calls[0].options.body.get("prompt"), "make this toy photorealistic");
  const image = calls[0].options.body.get("image");
  assert.equal(image.type, "image/png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), VIEW_BYTES);
  assert.equal(result.imageBase64, OUTPUT_BYTES.toString("base64"));
  assert.equal(result.revisedPrompt, "refined prompt");
});

test("generateImageFromReference downloads URL results", async () => {
  const calls = [];
  const result = await generateImageFromReference({
    baseUrl: "https://api.example.test/v1",
    apiKey: "test-key",
    model: "image-model",
    prompt: "render",
    imageBase64: VIEW_BYTES.toString("base64"),
    imageMimeType: "image/png",
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return jsonResponse({ data: [{ url: "https://cdn.example.test/result.webp" }] });
      }
      return new Response(OUTPUT_BYTES, {
        status: 200,
        headers: { "content-type": "image/webp" }
      });
    }
  });

  assert.deepEqual(calls, [
    "https://api.example.test/v1/images/edits",
    "https://cdn.example.test/result.webp"
  ]);
  assert.equal(result.mimeType, "image/webp");
  assert.equal(result.imageBase64, OUTPUT_BYTES.toString("base64"));
});

test("generateImageFromReference surfaces provider errors without the API key", async () => {
  await assert.rejects(
    generateImageFromReference({
      baseUrl: "https://api.example.test/v1",
      apiKey: "never-echo-this",
      model: "image-model",
      prompt: "render",
      imageBase64: VIEW_BYTES.toString("base64"),
      imageMimeType: "image/png",
      fetchImpl: async () => jsonResponse({ error: { message: "model unavailable" } }, 400)
    }),
    (error) => {
      assert.match(error.message, /model unavailable/);
      assert.doesNotMatch(error.message, /never-echo-this/);
      return true;
    }
  );
});
