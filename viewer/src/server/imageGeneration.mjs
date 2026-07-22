const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_INPUT_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_OUTPUT_IMAGE_BYTES = 24 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export class ImageGenerationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "ImageGenerationError";
    this.statusCode = statusCode;
  }
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new ImageGenerationError(`${label} is required`);
  }
  return text;
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
    throw new ImageGenerationError("Current view image is too large", 413);
  }
  return { bytes, mimeType: normalizedMimeType };
}

function responseImageType(response, fallback = "image/png") {
  const contentType = String(response?.headers?.get?.("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  return ALLOWED_IMAGE_TYPES.has(contentType) ? contentType : fallback;
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

async function fetchGeneratedImage(url, { fetchImpl, signal }) {
  let imageUrl;
  try {
    imageUrl = new URL(requiredText(url, "Generated image URL"));
  } catch {
    throw new ImageGenerationError("Image provider returned an invalid image URL", 502);
  }
  if (imageUrl.protocol !== "http:" && imageUrl.protocol !== "https:") {
    throw new ImageGenerationError("Image provider returned an unsupported image URL", 502);
  }
  const response = await fetchImpl(imageUrl, { signal, redirect: "follow" });
  if (!response.ok) {
    throw new ImageGenerationError(`Generated image download failed (${response.status})`, 502);
  }
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_OUTPUT_IMAGE_BYTES) {
    throw new ImageGenerationError("Generated image is too large", 502);
  }
  const mimeType = responseImageType(response);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_OUTPUT_IMAGE_BYTES) {
    throw new ImageGenerationError(bytes.length ? "Generated image is too large" : "Generated image is empty", 502);
  }
  return { bytes, mimeType };
}

export async function generateImageFromReference({
  baseUrl,
  apiKey,
  model,
  prompt,
  imageBase64,
  imageMimeType,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new ImageGenerationError("Image generation fetch is unavailable", 500);
  }
  const endpoint = imageEditsEndpoint(baseUrl);
  const normalizedApiKey = requiredText(apiKey, "API key");
  const normalizedModel = requiredText(model, "Model");
  const normalizedPrompt = requiredText(prompt, "Prompt");
  const inputImage = decodeInputImage(imageBase64, imageMimeType);
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));

  try {
    const formData = new FormData();
    formData.append("model", normalizedModel);
    formData.append("prompt", normalizedPrompt);
    formData.append("image", new Blob([inputImage.bytes], { type: inputImage.mimeType }), "cad-view.png");

    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${normalizedApiKey}` },
        body: formData,
        signal: abortController.signal,
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        throw new ImageGenerationError("Image generation timed out", 504);
      }
      throw new ImageGenerationError(error instanceof Error ? error.message : "Image provider request failed", 502);
    }
    if (!response.ok) {
      throw new ImageGenerationError(await responseErrorMessage(response), 502);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ImageGenerationError("Image provider returned invalid JSON", 502);
    }
    const image = Array.isArray(payload?.data) ? payload.data[0] : null;
    if (!image) {
      throw new ImageGenerationError("Image provider returned no image", 502);
    }

    let output;
    if (String(image.b64_json || "").trim()) {
      const bytes = Buffer.from(String(image.b64_json).replace(/\s+/gu, ""), "base64");
      if (!bytes.length || bytes.length > MAX_OUTPUT_IMAGE_BYTES) {
        throw new ImageGenerationError(bytes.length ? "Generated image is too large" : "Generated image is empty", 502);
      }
      output = { bytes, mimeType: "image/png" };
    } else if (String(image.url || "").trim()) {
      output = await fetchGeneratedImage(image.url, { fetchImpl, signal: abortController.signal });
    } else {
      throw new ImageGenerationError("Image provider returned no supported image data", 502);
    }

    return {
      imageBase64: output.bytes.toString("base64"),
      mimeType: output.mimeType,
      revisedPrompt: String(image.revised_prompt || "").trim(),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
