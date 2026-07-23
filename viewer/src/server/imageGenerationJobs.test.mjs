import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createImageGenerationJobStore } from "./imageGenerationJobs.mjs";

const VIEW_BYTES = Buffer.from("current-cad-view");
const OUTPUT_BYTES = Buffer.from("generated-image");

function createCacheDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cad-viewer-image-jobs-test-"));
}

function input(overrides = {}) {
  return {
    clientRequestId: "request-12345678",
    fileKey: "models/toy.step",
    baseUrl: "https://api.example.test/v1",
    apiKey: "secret-api-key",
    model: "image-model",
    prompt: "render the current CAD view",
    imageBase64: VIEW_BYTES.toString("base64"),
    imageMimeType: "image/png",
    ...overrides,
  };
}

async function waitForStatus(store, jobId, status) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = store.get(jobId);
    if (job?.status === status) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Task ${jobId} did not reach ${status}`);
}

test("image job store is idempotent, persists completed results, and excludes API keys", async () => {
  const cacheDirectory = createCacheDirectory();
  const providerCalls = [];
  try {
    const store = createImageGenerationJobStore({
      cacheDirectory,
      fetchImpl: async (url, options) => {
        providerCalls.push({ url: String(url), options });
        return new Response(JSON.stringify({
          data: [{ b64_json: OUTPUT_BYTES.toString("base64"), revised_prompt: "refined" }],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const first = store.create(input());
    const duplicate = store.create(input());
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.id, first.job.id);

    const completed = await waitForStatus(store, first.job.id, "completed");
    assert.equal(providerCalls.length, 1);
    assert.equal(completed.revisedPrompt, "refined");
    assert.deepEqual(store.readResult(first.job.id), {
      body: OUTPUT_BYTES,
      filename: "result.png",
      mimeType: "image/png",
    });

    const metadata = fs.readFileSync(path.join(cacheDirectory, first.job.id, "job.json"), "utf8");
    assert.doesNotMatch(metadata, /secret-api-key/);
    assert.doesNotMatch(metadata, /https:\/\/api\.example\.test/);

    const restoredStore = createImageGenerationJobStore({ cacheDirectory });
    assert.equal(restoredStore.get(first.job.id).status, "completed");
    assert.deepEqual(restoredStore.readResult(first.job.id), {
      body: OUTPUT_BYTES,
      filename: "result.png",
      mimeType: "image/png",
    });
  } finally {
    fs.rmSync(cacheDirectory, { recursive: true, force: true });
  }
});

test("image job store marks active tasks interrupted after a Viewer restart", async () => {
  const cacheDirectory = createCacheDirectory();
  let resolveProvider;
  try {
    const store = createImageGenerationJobStore({
      cacheDirectory,
      fetchImpl: () => new Promise((resolve) => {
        resolveProvider = resolve;
      }),
    });
    const created = store.create(input({ clientRequestId: "request-restart-123456" }));
    await waitForStatus(store, created.job.id, "requesting");

    const restartedStore = createImageGenerationJobStore({ cacheDirectory });
    const interrupted = restartedStore.get(created.job.id);
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.error.code, "job_interrupted");
    assert.equal(interrupted.error.retryable, true);

    resolveProvider(new Response(JSON.stringify({
      data: [{ b64_json: OUTPUT_BYTES.toString("base64") }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await waitForStatus(store, created.job.id, "completed");
  } finally {
    fs.rmSync(cacheDirectory, { recursive: true, force: true });
  }
});

test("image job store removes cached tasks after the retention period", () => {
  const cacheDirectory = createCacheDirectory();
  const now = Date.parse("2026-07-23T00:00:00.000Z");
  try {
    const store = createImageGenerationJobStore({
      cacheDirectory,
      ttlMs: 1000,
      now: () => now,
      fetchImpl: async () => new Response(JSON.stringify({
        data: [{ b64_json: OUTPUT_BYTES.toString("base64") }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    const created = store.create(input({ clientRequestId: "request-expiry-1234567" }));
    const jobDirectory = path.join(cacheDirectory, created.job.id);
    assert.equal(fs.existsSync(jobDirectory), true);

    const expiredStore = createImageGenerationJobStore({
      cacheDirectory,
      ttlMs: 1000,
      now: () => now + 1001,
    });
    assert.equal(expiredStore.get(created.job.id), null);
    assert.equal(fs.existsSync(jobDirectory), false);
  } finally {
    fs.rmSync(cacheDirectory, { recursive: true, force: true });
  }
});
