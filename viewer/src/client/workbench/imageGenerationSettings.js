export const DEFAULT_IMAGE_GENERATION_SETTINGS = Object.freeze({
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-image-1"
});

const LOCAL_STORAGE_KEY = "cad-viewer:image-generation-settings";
const SESSION_STORAGE_KEY = "cad-viewer:image-generation-api-key";

function normalizedText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function readJsonStorage(storage, key) {
  try {
    const value = storage?.getItem?.(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

export function normalizeImageGenerationSettings(value = {}) {
  return {
    baseUrl: normalizedText(value.baseUrl, DEFAULT_IMAGE_GENERATION_SETTINGS.baseUrl),
    apiKey: normalizedText(value.apiKey),
    model: normalizedText(value.model, DEFAULT_IMAGE_GENERATION_SETTINGS.model)
  };
}

export function readImageGenerationSettings({ localStorage, sessionStorage } = globalThis) {
  const persisted = readJsonStorage(localStorage, LOCAL_STORAGE_KEY) || {};
  let apiKey = "";
  try {
    apiKey = sessionStorage?.getItem?.(SESSION_STORAGE_KEY) || "";
  } catch {
    apiKey = "";
  }
  return normalizeImageGenerationSettings({ ...persisted, apiKey });
}

export function writeImageGenerationSettings(settings, { localStorage, sessionStorage } = globalThis) {
  const normalized = normalizeImageGenerationSettings(settings);
  try {
    localStorage?.setItem?.(LOCAL_STORAGE_KEY, JSON.stringify({
      baseUrl: normalized.baseUrl,
      model: normalized.model
    }));
  } catch {
    // Storage is optional; the in-memory form remains usable.
  }
  try {
    if (normalized.apiKey) {
      sessionStorage?.setItem?.(SESSION_STORAGE_KEY, normalized.apiKey);
    } else {
      sessionStorage?.removeItem?.(SESSION_STORAGE_KEY);
    }
  } catch {
    // Session storage is optional; never fall back to persistent key storage.
  }
  return normalized;
}

export function imageGenerationValidationError({ baseUrl, apiKey, model, prompt } = {}) {
  if (!normalizedText(baseUrl)) {
    return "Enter a Base URL in Settings.";
  }
  try {
    const url = new URL(normalizedText(baseUrl));
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "Base URL must use HTTP or HTTPS.";
    }
  } catch {
    return "Enter a valid Base URL in Settings.";
  }
  if (!normalizedText(apiKey)) {
    return "Enter an API key in Settings.";
  }
  if (!normalizedText(model)) {
    return "Enter a model in Settings.";
  }
  if (!normalizedText(prompt)) {
    return "Describe the image you want to generate.";
  }
  return "";
}

export async function blobToBase64(blob) {
  if (!(blob instanceof Blob)) {
    throw new Error("Current view screenshot is unavailable.");
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function base64ImageToBlob(base64, mimeType = "image/png") {
  const binary = atob(String(base64 || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: String(mimeType || "image/png") });
}
