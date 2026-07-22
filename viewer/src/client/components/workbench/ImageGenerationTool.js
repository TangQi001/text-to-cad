import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  ImagePlus,
  LoaderCircle,
  Settings2
} from "lucide-react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { copyImageBlobToClipboard } from "@/ui/clipboard";
import { cn } from "@/ui/utils";
import { useImageGenerationContext } from "@/workbench/imageGenerationContext";
import {
  base64ImageToBlob,
  blobToBase64,
  imageGenerationValidationError,
  readImageGenerationSettings,
  writeImageGenerationSettings
} from "@/workbench/imageGenerationSettings";
import { FILE_SHEET_FIELD_LABEL_CLASSES } from "./FileSheet";

function DisclosureButton({ open, icon: Icon, children, onClick }) {
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-8 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left text-[12px] text-sidebar-foreground/85 transition-colors",
        "hover:bg-sidebar-accent/55 hover:text-sidebar-accent-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
      )}
      aria-expanded={open}
      onClick={onClick}
    >
      <ChevronRight
        className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        strokeWidth={2}
        aria-hidden="true"
      />
      {Icon ? <Icon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} aria-hidden="true" /> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

function Field({ label, children }) {
  return (
    <label className="block min-w-0 space-y-1">
      <span className={FILE_SHEET_FIELD_LABEL_CLASSES}>{label}</span>
      {children}
    </label>
  );
}

export default function ImageGenerationTool() {
  const imageGeneration = useImageGenerationContext();
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [settings, setSettings] = useState(() => readImageGenerationSettings());
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const resultUrl = useMemo(() => (
    result?.blob ? URL.createObjectURL(result.blob) : ""
  ), [result]);

  useEffect(() => () => {
    if (resultUrl) {
      URL.revokeObjectURL(resultUrl);
    }
  }, [resultUrl]);

  const updateSetting = (key, value) => {
    setSettings((current) => {
      const nextSettings = { ...current, [key]: value };
      writeImageGenerationSettings(nextSettings);
      return nextSettings;
    });
  };

  const handleGenerate = async () => {
    const validationError = imageGenerationValidationError({ ...settings, prompt });
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!imageGeneration?.available || typeof imageGeneration.captureCurrentViewBlob !== "function") {
      setError("Image generation requires a local CAD Viewer with a rendered view.");
      return;
    }

    setGenerating(true);
    setError("");
    setCopied(false);
    try {
      const viewBlob = await imageGeneration.captureCurrentViewBlob();
      const response = await fetch("/__cad/image-generation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          model: settings.model,
          prompt: prompt.trim(),
          imageBase64: await blobToBase64(viewBlob),
          imageMimeType: viewBlob.type || "image/png"
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.ok || !payload?.imageBase64) {
        throw new Error(payload?.error || `Image generation failed (${response.status})`);
      }
      setResult({
        blob: base64ImageToBlob(payload.imageBase64, payload.mimeType),
        revisedPrompt: String(payload.revisedPrompt || "").trim()
      });
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : "Image generation failed.");
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = async () => {
    if (!result?.blob) {
      return;
    }
    try {
      await copyImageBlobToClipboard(result.blob, { type: result.blob.type || "image/png" });
      setCopied(true);
      window.setTimeout?.(() => setCopied(false), 1200);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "Image copy failed.");
    }
  };

  return (
    <div className="mx-3 my-2 overflow-hidden rounded-md border border-sidebar-border/80 bg-sidebar-accent/15">
      <DisclosureButton open={open} icon={ImagePlus} onClick={() => setOpen((value) => !value)}>
        Generate image
      </DisclosureButton>

      {open ? (
        <div className="space-y-3 border-t border-sidebar-border/70 p-2.5">
          <div className="overflow-hidden rounded-sm border border-sidebar-border/70">
            <DisclosureButton open={settingsOpen} icon={Settings2} onClick={() => setSettingsOpen((value) => !value)}>
              Settings
            </DisclosureButton>
            {settingsOpen ? (
              <div className="space-y-2.5 border-t border-sidebar-border/60 p-2.5">
                <Field label="Base URL">
                  <Input
                    aria-label="Base URL"
                    value={settings.baseUrl}
                    onChange={(event) => updateSetting("baseUrl", event.target.value)}
                    placeholder="https://api.openai.com/v1"
                    className="!h-8 px-2 !text-[11px]"
                    autoComplete="url"
                  />
                </Field>
                <Field label="API key">
                  <div className="relative">
                    <Input
                      aria-label="API key"
                      type={showApiKey ? "text" : "password"}
                      value={settings.apiKey}
                      onChange={(event) => updateSetting("apiKey", event.target.value)}
                      placeholder="Stored for this tab only"
                      className="!h-8 px-2 pr-8 !text-[11px]"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="absolute inset-y-0 right-0 grid w-8 place-items-center text-muted-foreground hover:text-foreground"
                      onClick={() => setShowApiKey((value) => !value)}
                      aria-label={showApiKey ? "Hide API key" : "Show API key"}
                      title={showApiKey ? "Hide API key" : "Show API key"}
                    >
                      {showApiKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </button>
                  </div>
                </Field>
                <Field label="Model">
                  <Input
                    aria-label="Model"
                    value={settings.model}
                    onChange={(event) => updateSetting("model", event.target.value)}
                    placeholder="gpt-image-1"
                    className="!h-8 px-2 !text-[11px]"
                  />
                </Field>
                <p className="text-[10px] leading-4 text-muted-foreground">
                  The API key stays in this browser tab. It is sent only when you generate an image.
                </p>
              </div>
            ) : null}
          </div>

          <Field label="Prompt">
            <Textarea
              aria-label="Prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe the refined image while preserving this camera angle..."
              className="min-h-24 resize-y px-2 py-2 !text-[11px] leading-4"
            />
          </Field>

          <Button
            type="button"
            size="sm"
            className="h-8 w-full text-[11px]"
            disabled={generating || !imageGeneration?.available}
            onClick={() => void handleGenerate()}
          >
            {generating ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <ImagePlus className="size-3.5" aria-hidden="true" />}
            {generating ? "Generating..." : "Generate image"}
          </Button>

          {!imageGeneration?.available ? (
            <p className="text-[10px] leading-4 text-muted-foreground">
              Start the local CAD Viewer and open a rendered file to use image generation.
            </p>
          ) : null}
          {error ? <p role="alert" className="text-[10px] leading-4 text-destructive">{error}</p> : null}

          {resultUrl ? (
            <div className="space-y-1.5">
              <span className={FILE_SHEET_FIELD_LABEL_CLASSES}>Generated image</span>
              <button
                type="button"
                className="group relative block aspect-square w-full overflow-hidden rounded-md border border-sidebar-border bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
                onClick={() => setPreviewOpen(true)}
                title="Open generated image"
              >
                <img src={resultUrl} alt="AI generated from the current CAD view" className="size-full object-contain" />
                <span className="absolute inset-x-0 bottom-0 bg-background/85 px-2 py-1 text-[10px] text-foreground opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  Open image
                </span>
              </button>
              {result.revisedPrompt ? (
                <p className="line-clamp-3 text-[10px] leading-4 text-muted-foreground">{result.revisedPrompt}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[calc(100vh-2rem)] gap-3 p-4 sm:max-w-5xl">
          <DialogHeader className="pr-10">
            <DialogTitle className="text-base">Generated image</DialogTitle>
            <DialogDescription>Right-click the image to copy or save it.</DialogDescription>
          </DialogHeader>
          {resultUrl ? (
            <div className="min-h-0 overflow-auto rounded-md border bg-muted/30">
              <img src={resultUrl} alt="AI generated from the current CAD view, enlarged" className="mx-auto max-h-[70vh] w-auto max-w-full object-contain" />
            </div>
          ) : null}
          <div className="flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy()} disabled={!result?.blob}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? "Copied" : "Copy image"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
