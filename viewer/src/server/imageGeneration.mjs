const DEFAULT_PROVIDER_TIMEOUT_MS = 300_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_INPUT_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_OUTPUT_IMAGE_BYTES = 24 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export class ImageGenerationError extends Error {
  constructor(message, {
    statusCode = 400,
    code = "image_generation_invalid",
    stage = "validation",
    retryable = false,
    providerStatus = 0,
  } = {}) {
    super(message);
    this.name = "ImageGenerationError";
    this.statusCode = statusCode;
    this.code = code;
    this.stage = stage;
    this.retryable = retryable;
    this.providerStatus = providerStatus;
  }
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new ImageGenerationError(`${label} is required`);
  }
  return text;
}

function boundedText(value, label, maxLength) {
  const text = requiredText(value, label);
  if (text.length > maxLength) {
    throw new ImageGenerationError(`${label} is too long`);
  }
  return text;
}

export function imageGenerationErrorPayload(error) {
  const normalized = error instanceof ImageGenerationError
    ? error
    : new ImageGenerationError("Image generation failed", {
      statusCode: 500,
      code: "image_generation_internal",
      stage: "internal",
      retryable: false,
    });
  return {
    code: normalized.code,
    stage: normalized.stage,
    message: normalized.message,
    retryable: normalized.retryable === true,
    providerStatus: Number(normalized.providerStatus) || 0,
  };
}

export function imageEditsEndpoint(baseUrl) {
  const rawBaseUrl = requiredText(baseUrl, "Base URL");
  let url;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new ImageGenerationError("Base URL must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ImageGenerationError("Base URL must use HTTP or HTTPS");
  }
  url.search = "";
  url.hash = "";
  const pathname = url.pathname.replace(/\/+$/u, "");
  url.pathname = pathname.endsWith("/images/edits")
    ? pathname
    : `${pathname}/images/edits`.replace(/\/{2,}/gu, "/");
  return url.toString();
}

function decodeInputImage(base64, mimeType) {
  const normalizedMimeType = String(mimeType || "image/png").trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(normalizedMimeType)) {
    throw new ImageGenerationError("Current view must be a PNG, JPEG, or WebP image");
  }
  const normalizedBase64 = requiredText(base64, "Current view image").replace(/\s+/gu, "");
  if (!/^[a-zA-Z0-9+/]*={0,2}$/u.test(normalizedBase64)) {
    throw new ImageGenerationError("Current view image is not valid base64 data");
  }
  const bytes = Buffer.from(normalizedBase64, "base64");
  if (!bytes.length) {
    throw new ImageGenerationError("Current view image is empty");
  }
  if (bytes.length > MAX_INPUT_IMAGE_BYTES) {
    throw new ImageGenerationError("Current view image is too large", {
      statusCode: 413,
      code: "input_image_too_large",
    });
  }
  return { bytes, mimeType: normalizedMimeType };
}

export function prepareImageGenerationInput({
  baseUrl,
  apiKey,
  model,
  prompt,
  imageBase64,
  imageMimeType,
} = {}) {
  return {
    endpoint: imageEditsEndpoint(baseUrl),
    apiKey: boundedText(apiKey, "API key", 4096),
    model: boundedText(model, "Model", 256),
    prompt: boundedText(prompt, "Prompt", 16_000),
    inputImage: decodeInputImage(imageBase64, imageMimeType),
  };
}

function responseImageType(response, fallback = "image/png") {
  const contentType = String(response?.headers?.get?.("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  return ALLOWED_IMAGE_TYPES.has(contentType) ? contentType : fallback;
}

function providerErrorForStatus(status, message) {
  const providerStatus = Number(status) || 0;
  if (providerStatus === 401 || providerStatus === 403) {
    return new ImageGenerationError(message || "Image provider rejected the API key", {
      statusCode: 502,
      code: "provider_authentication_failed",
      stage: "requesting",
      providerStatus,
    });
  }
  if (providerStatus === 429) {
    return new ImageGenerationError(message || "Image provider rate limited this request", {
      statusCode: 429,
      code: "provider_rate_limited",
      stage: "requesting",
      retryable: true,
      providerStatus,
    });
  }
  if (providerStatus === 408 || providerStatus === 504) {
    return new ImageGenerationError(message || "Image provider timed out", {
      statusCode: 504,
      code: "provider_timeout",
      stage: "requesting",
      retryable: true,
      providerStatus,
    });
  }
  if (providerStatus >= 500) {
    return new ImageGenerationError(message || `Image provider returned ${providerStatus}`, {
      statusCode: 502,
      code: "provider_unavailable",
      stage: "requesting",
      retryable: true,
      providerStatus,
    });
  }
  return new ImageGenerationError(message || `Image provider returned ${providerStatus}`, {
    statusCode: 422,
    code: "provider_request_rejected",
    stage: "requesting",
    providerStatus,
  });
}

async function responseErrorMessage(response) {
  const fallback = `Image provider returned ${response.status}`;
  try {
    const payload = await response.json();
    return String(payload?.error?.message || payload?.error || payload?.message || fallback).trim() || fallback;
  } catch {
    return fallback;
  }
}

function timeoutError(stage, code, message) {
  return new ImageGenerationError(message, {
    statusCode: 504,
    code,
    stage,
    retryable: true,
  });
}

async function runWithTimeout(task, {
  timeoutMs,
  stage,
  timeoutCode,
  timeoutMessage,
} = {}) {
  const controller = new AbortController();
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(timeoutError(stage, timeoutCode, timeoutMessage));
    }, Math.max(1, Number(timeoutMs) || 1));
  });
  try {
    return await Promise.race([task(controller.signal), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readProviderJson(response, { timeoutMs }) {
  try {
    return await runWithTimeout(
      async () => await response.json(),
      {
        timeoutMs,
        stage: "reading_response",
        timeoutCode: "provider_response_timeout",
        timeoutMessage: "Image provider response timed out",
      }
    );
  } catch (error) {
    if (error instanceof ImageGenerationError) {
      throw error;
    }
    throw new ImageGenerationError("Image provider returned invalid JSON", {
      statusCode: 502,
      code: "provider_invalid_response",
      stage: "reading_response",
      retryable: true,
    });
  }
}

async function fetchGeneratedImage(url, { fetchImpl, timeoutMs, onStage }) {
  let imageUrl;
  try {
    imageUrl = new URL(requiredText(url, "Generated image URL"));
  } catch {
    throw new ImageGenerationError("Image provider returned an invalid image URL", {
      statusCode: 502,
      code: "result_url_invalid",
      stage: "downloading_result",
    });
  }
  if (imageUrl.protocol !== "http:" && imageUrl.protocol !== "https:") {
    throw new ImageGenerationError("Image provider returned an unsupported image URL", {
      statusCode: 502,
      code: "result_url_unsupported",
      stage: "downloading_result",
    });
  }
  onStage?.("downloading_result");
  let response;
  try {
    response = await runWithTimeout(
      async (signal) => await fetchImpl(imageUrl, { signal, redirect: "follow" }),
      {
        timeoutMs,
        stage: "downloading_result",
        timeoutCode: "result_download_timeout",
        timeoutMessage: "Generated image download timed out",
      }
    );
  } catch (error) {
    if (error instanceof ImageGenerationError) {
      throw error;
    }
    throw new ImageGenerationError("Generated image download failed", {
      statusCode: 502,
      code: "result_download_transport_error",
      stage: "downloading_result",
      retryable: true,
    });
  }
  if (!response.ok) {
    throw new ImageGenerationError(`Generated image download failed (${response.status})`, {
      statusCode: 502,
      code: "result_download_rejected",
      stage: "downloading_result",
      retryable: Number(response.status) >= 500,
      providerStatus: response.status,
    });
  }
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_OUTPUT_IMAGE_BYTES) {
    throw new ImageGenerationError("Generated image is too large", {
      statusCode: 502,
      code: "result_image_too_large",
      stage: "downloading_result",
    });
  }
  let bytes;
  try {
    bytes = Buffer.from(await runWithTimeout(
      async () => await response.arrayBuffer(),
      {
        timeoutMs,
        stage: "downloading_result",
        timeoutCode: "result_download_timeout",
        timeoutMessage: "Generated image download timed out",
      }
    ));
  } catch (error) {
    if (error instanceof ImageGenerationError) {
      throw error;
    }
    throw new ImageGenerationError("Generated image download failed", {
      statusCode: 502,
      code: "result_download_transport_error",
      stage: "downloading_result",
      retryable: true,
    });
  }
  if (!bytes.length || bytes.length > MAX_OUTPUT_IMAGE_BYTES) {
    throw new ImageGenerationError(bytes.length ? "Generated image is too large" : "Generated image is empty", {
      statusCode: 502,
      code: bytes.length ? "result_image_too_large" : "result_image_empty",
      stage: "downloading_result",
    });
  }
  return { bytes, mimeType: responseImageType(response) };
}

export async function generateImageBinaryFromReference(input = {}, {
  fetchImpl = globalThis.fetch,
  providerTimeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS,
  downloadTimeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  onStage,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new ImageGenerationError("Image generation fetch is unavailable", {
      statusCode: 500,
      code: "image_generation_fetch_unavailable",
      stage: "internal",
    });
  }
  const prepared = input?.endpoint && input?.inputImage
    ? input
    : prepareImageGenerationInput(input);

  const formData = new FormData();
  formData.append("model", prepared.model);
  formData.append("prompt", prepared.prompt);
  formData.append("image", new Blob([prepared.inputImage.bytes], { type: prepared.inputImage.mimeType }), "cad-view.png");

  onStage?.("requesting");
  let response;
  try {
    response = await runWithTimeout(
      async (signal) => await fetchImpl(prepared.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${prepared.apiKey}` },
        body: formData,
        signal,
      }),
      {
        timeoutMs: providerTimeoutMs,
        stage: "requesting",
        timeoutCode: "provider_timeout",
        timeoutMessage: "Image provider did not respond in time",
      }
    );
  } catch (error) {
    if (error instanceof ImageGenerationError) {
      throw error;
    }
    throw new ImageGenerationError("Image provider request failed", {
      statusCode: 502,
      code: "provider_transport_error",
      stage: "requesting",
      retryable: true,
    });
  }
  if (!response.ok) {
    throw providerErrorForStatus(response.status, await responseErrorMessage(response));
  }

  onStage?.("reading_response");
  const payload = await readProviderJson(response, { timeoutMs: providerTimeoutMs });
  const image = Array.isArray(payload?.data) ? payload.data[0] : null;
  if (!image) {
    throw new ImageGenerationError("Image provider returned no image", {
      statusCode: 502,
      code: "provider_missing_image",
      stage: "reading_response",
      retryable: true,
    });
  }

  let output;
  if (String(image.b64_json || "").trim()) {
    const bytes = Buffer.from(String(image.b64_json).replace(/\s+/gu, ""), "base64");
    if (!bytes.length || bytes.length > MAX_OUTPUT_IMAGE_BYTES) {
      throw new ImageGenerationError(bytes.length ? "Generated image is too large" : "Generated image is empty", {
        statusCode: 502,
        code: bytes.length ? "result_image_too_large" : "result_image_empty",
        stage: "reading_response",
      });
    }
    output = { bytes, mimeType: "image/png" };
  } else if (String(image.url || "").trim()) {
    output = await fetchGeneratedImage(image.url, { fetchImpl, timeoutMs: downloadTimeoutMs, onStage });
  } else {
    throw new ImageGenerationError("Image provider returned no supported image data", {
      statusCode: 502,
      code: "provider_missing_image_data",
      stage: "reading_response",
      retryable: true,
    });
  }

  return {
    ...output,
    revisedPrompt: String(image.revised_prompt || "").trim(),
  };
}

// Compatibility helper for callers that still need a JSON-safe image payload.
export async function generateImageFromReference(input = {}, options = {}) {
  const { fetchImpl: legacyFetchImpl, ...requestInput } = input || {};
  const result = await generateImageBinaryFromReference(requestInput, {
    ...(typeof legacyFetchImpl === "function" ? { fetchImpl: legacyFetchImpl } : {}),
    ...options,
  });
  return {
    imageBase64: result.bytes.toString("base64"),
    mimeType: result.mimeType,
    revisedPrompt: result.revisedPrompt,
  };
}
