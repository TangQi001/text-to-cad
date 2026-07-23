import { createContext, useContext } from "react";

export const IMAGE_GENERATION_IDLE_STATE = Object.freeze({
  prompt: "",
  clientRequestId: "",
  jobId: "",
  resultUrl: "",
  status: "idle",
  stage: "",
  revisedPrompt: "",
  error: null,
  toolOpen: false,
  settingsOpen: false,
});

export function normalizeImageGenerationState(value = {}) {
  return {
    ...IMAGE_GENERATION_IDLE_STATE,
    ...(value && typeof value === "object" ? value : {}),
    prompt: String(value?.prompt || ""),
    clientRequestId: String(value?.clientRequestId || ""),
    jobId: String(value?.jobId || ""),
    resultUrl: String(value?.resultUrl || ""),
    status: String(value?.status || "idle"),
    stage: String(value?.stage || ""),
    revisedPrompt: String(value?.revisedPrompt || ""),
    error: value?.error && typeof value.error === "object" ? { ...value.error } : null,
    toolOpen: value?.toolOpen === true,
    settingsOpen: value?.settingsOpen === true,
  };
}

const ImageGenerationContext = createContext(null);

export const ImageGenerationProvider = ImageGenerationContext.Provider;

export function useImageGenerationContext() {
  return useContext(ImageGenerationContext);
}
