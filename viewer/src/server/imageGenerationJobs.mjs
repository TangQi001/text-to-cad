import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ImageGenerationError,
  generateImageBinaryFromReference,
  imageGenerationErrorPayload,
  prepareImageGenerationInput,
} from "./imageGeneration.mjs";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const JOB_METADATA_FILENAME = "job.json";
const RESULT_FILENAME = "result";
const ACTIVE_JOB_STATUSES = new Set(["queued", "requesting", "reading_response", "downloading_result"]);
const RESULT_EXTENSIONS = Object.freeze({
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
});

function normalizeText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function normalizePositiveNumber(value, fallback) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : fallback;
}

function safeJobId(value) {
  const text = normalizeText(value);
  return /^[a-zA-Z0-9_-]{8,128}$/u.test(text) ? text : "";
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function resultExtensionForMimeType(mimeType) {
  return RESULT_EXTENSIONS[String(mimeType || "").toLowerCase()] || ".png";
}

function defaultCacheDirectory() {
  return path.join(os.tmpdir(), "cad-viewer-image-generation");
}

function atomicWriteJson(filePath, payload, fsImpl = fs) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fsImpl.writeFileSync(temporaryPath, JSON.stringify(payload), "utf8");
  fsImpl.renameSync(temporaryPath, filePath);
}

function readJsonFile(filePath, fsImpl = fs) {
  try {
    return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function defaultJobRecord({ id, clientRequestId, fileKey, prompt, now }) {
  return {
    id,
    clientRequestId,
    fileKey,
    prompt,
    status: "queued",
    stage: "queued",
    createdAt: nowIso(now),
    updatedAt: nowIso(now),
    completedAt: "",
    revisedPrompt: "",
    result: null,
    error: null,
    timings: {
      queuedAt: nowIso(now),
    },
  };
}

function normalizeStoredJob(rawValue, { now = Date.now() } = {}) {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }
  const id = safeJobId(rawValue.id);
  if (!id) {
    return null;
  }
  const status = normalizeText(rawValue.status, "failed");
  const active = ACTIVE_JOB_STATUSES.has(status);
  const updatedAt = normalizeText(rawValue.updatedAt, nowIso(now));
  const job = {
    id,
    clientRequestId: normalizeText(rawValue.clientRequestId),
    fileKey: normalizeText(rawValue.fileKey),
    prompt: normalizeText(rawValue.prompt),
    status: active ? "interrupted" : status,
    stage: active ? "interrupted" : normalizeText(rawValue.stage, status),
    createdAt: normalizeText(rawValue.createdAt, updatedAt),
    updatedAt,
    completedAt: normalizeText(rawValue.completedAt),
    revisedPrompt: normalizeText(rawValue.revisedPrompt),
    result: rawValue.result && typeof rawValue.result === "object" ? {
      filename: normalizeText(rawValue.result.filename),
      mimeType: normalizeText(rawValue.result.mimeType, "image/png"),
      bytes: Math.max(Number(rawValue.result.bytes) || 0, 0),
    } : null,
    error: rawValue.error && typeof rawValue.error === "object" ? {
      code: normalizeText(rawValue.error.code, "image_generation_failed"),
      stage: normalizeText(rawValue.error.stage, "internal"),
      message: normalizeText(rawValue.error.message, "Image generation failed"),
      retryable: rawValue.error.retryable === true,
      providerStatus: Math.max(Number(rawValue.error.providerStatus) || 0, 0),
    } : null,
    timings: rawValue.timings && typeof rawValue.timings === "object" ? { ...rawValue.timings } : {},
  };
  if (active) {
    job.error = {
      code: "job_interrupted",
      stage: "interrupted",
      message: "Viewer restarted before image generation finished",
      retryable: true,
      providerStatus: 0,
    };
    job.completedAt = nowIso(now);
    job.updatedAt = nowIso(now);
    job.timings.interruptedAt = nowIso(now);
  }
  return job;
}

function safePublicJob(job) {
  return cloneJson({
    id: job.id,
    clientRequestId: job.clientRequestId,
    fileKey: job.fileKey,
    prompt: job.prompt,
    status: job.status,
    stage: job.stage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    revisedPrompt: job.revisedPrompt,
    result: job.result,
    error: job.error,
    timings: job.timings,
  });
}

export class ImageGenerationJobStore {
  constructor({
    cacheDirectory = process.env.VIEWER_IMAGE_GENERATION_CACHE_DIR || defaultCacheDirectory(),
    ttlMs = normalizePositiveNumber(process.env.VIEWER_IMAGE_GENERATION_TTL_MS, DEFAULT_TTL_MS),
    providerTimeoutMs = normalizePositiveNumber(process.env.VIEWER_IMAGE_GENERATION_PROVIDER_TIMEOUT_MS, 300_000),
    downloadTimeoutMs = normalizePositiveNumber(process.env.VIEWER_IMAGE_GENERATION_DOWNLOAD_TIMEOUT_MS, 60_000),
    cleanupIntervalMs = DEFAULT_CLEANUP_INTERVAL_MS,
    fetchImpl = globalThis.fetch,
    fsImpl = fs,
    now = () => Date.now(),
  } = {}) {
    this.cacheDirectory = path.resolve(cacheDirectory);
    this.ttlMs = ttlMs;
    this.providerTimeoutMs = providerTimeoutMs;
    this.downloadTimeoutMs = downloadTimeoutMs;
    this.fetchImpl = fetchImpl;
    this.fs = fsImpl;
    this.now = now;
    this.jobs = new Map();
    this.clientRequestIds = new Map();
    this.fs.mkdirSync(this.cacheDirectory, { recursive: true });
    this.restore();
    this.cleanupTimer = setInterval(() => this.cleanup(), normalizePositiveNumber(cleanupIntervalMs, DEFAULT_CLEANUP_INTERVAL_MS));
    this.cleanupTimer.unref?.();
  }

  jobDirectory(jobId) {
    return path.join(this.cacheDirectory, jobId);
  }

  metadataPath(jobId) {
    return path.join(this.jobDirectory(jobId), JOB_METADATA_FILENAME);
  }

  resultPath(job) {
    if (!job?.result?.filename) {
      return "";
    }
    return path.join(this.jobDirectory(job.id), job.result.filename);
  }

  restore() {
    this.cleanup();
    for (const entry of this.fs.readdirSync(this.cacheDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const job = normalizeStoredJob(readJsonFile(path.join(this.cacheDirectory, entry.name, JOB_METADATA_FILENAME), this.fs), {
        now: this.now(),
      });
      if (!job) {
        continue;
      }
      if (job.status === "interrupted") {
        this.persist(job);
      }
      if (job.result && !this.fs.existsSync(this.resultPath(job))) {
        job.result = null;
        job.status = "failed";
        job.stage = "result_missing";
        job.error = {
          code: "result_missing",
          stage: "result_missing",
          message: "Cached generated image is no longer available",
          retryable: true,
          providerStatus: 0,
        };
        job.updatedAt = nowIso(this.now());
        this.persist(job);
      }
      this.jobs.set(job.id, job);
      if (job.clientRequestId) {
        this.clientRequestIds.set(job.clientRequestId, job.id);
      }
    }
  }

  cleanup() {
    const expiration = this.now() - this.ttlMs;
    for (const entry of this.fs.readdirSync(this.cacheDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const directoryPath = path.join(this.cacheDirectory, entry.name);
      const rawJob = readJsonFile(path.join(directoryPath, JOB_METADATA_FILENAME), this.fs);
      const updatedAt = Date.parse(rawJob?.updatedAt || "") || 0;
      if (!rawJob || updatedAt < expiration) {
        const job = this.jobs.get(entry.name);
        if (job?.clientRequestId && this.clientRequestIds.get(job.clientRequestId) === entry.name) {
          this.clientRequestIds.delete(job.clientRequestId);
        }
        this.jobs.delete(entry.name);
        this.fs.rmSync(directoryPath, { recursive: true, force: true });
      }
    }
  }

  persist(job) {
    this.fs.mkdirSync(this.jobDirectory(job.id), { recursive: true });
    atomicWriteJson(this.metadataPath(job.id), safePublicJob(job), this.fs);
  }

  update(job, patch = {}) {
    Object.assign(job, patch);
    job.updatedAt = nowIso(this.now());
    this.persist(job);
    return job;
  }

  updateStage(job, stage) {
    const timestamp = nowIso(this.now());
    job.status = stage;
    job.stage = stage;
    job.timings[`${stage}At`] = timestamp;
    job.updatedAt = timestamp;
    this.persist(job);
  }

  get(jobId) {
    const job = this.jobs.get(safeJobId(jobId));
    return job ? safePublicJob(job) : null;
  }

  getByClientRequestId(clientRequestId) {
    const jobId = this.clientRequestIds.get(normalizeText(clientRequestId));
    return jobId ? this.get(jobId) : null;
  }

  readResult(jobId) {
    const job = this.jobs.get(safeJobId(jobId));
    if (!job?.result || job.status !== "completed") {
      return null;
    }
    const resultPath = this.resultPath(job);
    try {
      return {
        body: this.fs.readFileSync(resultPath),
        filename: job.result.filename,
        mimeType: job.result.mimeType,
      };
    } catch {
      return null;
    }
  }

  create({ clientRequestId, fileKey, prompt, ...input } = {}) {
    const normalizedClientRequestId = safeJobId(clientRequestId) || crypto.randomUUID();
    const existingJobId = this.clientRequestIds.get(normalizedClientRequestId);
    if (existingJobId) {
      const existing = this.get(existingJobId);
      if (existing) {
        return { job: existing, created: false };
      }
    }

    const preparedInput = prepareImageGenerationInput({ ...input, prompt });
    const id = crypto.randomUUID();
    const job = defaultJobRecord({
      id,
      clientRequestId: normalizedClientRequestId,
      fileKey: normalizeText(fileKey),
      prompt: preparedInput.prompt,
      now: this.now(),
    });
    this.jobs.set(id, job);
    this.clientRequestIds.set(normalizedClientRequestId, id);
    this.persist(job);
    void this.run(job, preparedInput);
    return { job: safePublicJob(job), created: true };
  }

  async run(job, preparedInput) {
    try {
      const result = await generateImageBinaryFromReference(preparedInput, {
        fetchImpl: this.fetchImpl,
        providerTimeoutMs: this.providerTimeoutMs,
        downloadTimeoutMs: this.downloadTimeoutMs,
        onStage: (stage) => this.updateStage(job, stage),
      });
      const filename = `${RESULT_FILENAME}${resultExtensionForMimeType(result.mimeType)}`;
      const resultPath = path.join(this.jobDirectory(job.id), filename);
      this.fs.writeFileSync(resultPath, result.bytes);
      const timestamp = nowIso(this.now());
      job.status = "completed";
      job.stage = "completed";
      job.completedAt = timestamp;
      job.updatedAt = timestamp;
      job.revisedPrompt = result.revisedPrompt;
      job.result = {
        filename,
        mimeType: result.mimeType,
        bytes: result.bytes.length,
      };
      job.error = null;
      job.timings.completedAt = timestamp;
      this.persist(job);
    } catch (error) {
      const details = imageGenerationErrorPayload(error);
      const timestamp = nowIso(this.now());
      job.status = "failed";
      job.stage = details.stage || "failed";
      job.completedAt = timestamp;
      job.updatedAt = timestamp;
      job.error = details;
      job.timings.failedAt = timestamp;
      this.persist(job);
    }
  }
}

export function createImageGenerationJobStore(options) {
  return new ImageGenerationJobStore(options);
}
