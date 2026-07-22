import { createContext, useContext } from "react";

const ImageGenerationContext = createContext(null);

export const ImageGenerationProvider = ImageGenerationContext.Provider;

export function useImageGenerationContext() {
  return useContext(ImageGenerationContext);
}
