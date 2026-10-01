import { MAX_OCR_PAGES } from "../../shared/constants";
import { pdfPagesToText } from "../../shared/extract/plain";
import { FileReadError } from "../../shared/fileExtract";
import { FileText } from "../../shared/fileSource";
import { readImage } from "../api";
import { openPdf } from "./pdf";

/* global AbortSignal, File, HTMLCanvasElement, document, FileReader */

/**
 * Wide enough that small print survives. JPEG at 0.92 keeps a thin stroke on a
 * chart. 0.85 erased it, and one page still fits the OCR body after base64.
 */
const RASTER_WIDTH = 1700;
const RASTER_QUALITY = 0.92;

export type OcrSettings = {
  llmBaseUrl: string;
  llmApiKey: string;
  model: string;
  timeoutMs: number;
};

function canvasImage(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/jpeg", RASTER_QUALITY);
}

/** A picture is already an image, so it goes to the model as it stands. */
function imageDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new FileReadError("画像を読み込めませんでした。"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      if (result.startsWith("data:image/")) {
        resolve(result);
      } else {
        reject(new FileReadError("画像として読み込めませんでした。"));
      }
    };
    reader.readAsDataURL(file);
  });
}

async function renderPdfPages(
  file: File,
  limit: number,
  onPage: (page: string, index: number) => Promise<void>,
  signal: AbortSignal
): Promise<void> {
  const handle = await openPdf(await file.arrayBuffer());
  try {
    const pages = Math.min(handle.doc.numPages, limit);
    for (let number = 1; number <= pages; number += 1) {
      signal.throwIfAborted();
      const page = await handle.doc.getPage(number);
      try {
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: RASTER_WIDTH / base.width });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const context = canvas.getContext("2d");
        if (!context) {
          throw new FileReadError("このパソコンでは PDF を画像にできませんでした。");
        }
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        await onPage(canvasImage(canvas), number - 1);
        // Freed before the next page so a long scan does not pile up bitmaps.
        canvas.width = 0;
        canvas.height = 0;
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await handle.close();
  }
}

/**
 * Reads a scan page by page. One request per page keeps a long document off a
 * single huge reply, and lets the badge say how far it has got.
 */
export async function ocrFile(
  file: File,
  pages: number,
  settings: OcrSettings,
  onProgress: (done: number, total: number) => void,
  signal: AbortSignal
): Promise<FileText> {
  if (!settings.llmBaseUrl.trim() || !settings.llmApiKey.trim()) {
    throw new FileReadError(
      "画像を読むには接続の設定が必要です。設定で URL と APIキーを入れてください。"
    );
  }
  const total = Math.min(Math.max(1, pages), MAX_OCR_PAGES);
  const read: string[] = [];

  const page = async (image: string, index: number) => {
    signal.throwIfAborted();
    try {
      read[index] = await readImage({ ...settings, image }, signal);
    } catch (error) {
      if (signal.aborted || !(error instanceof Error)) {
        throw error;
      }
      // The sidecar already answers in words for the user, including the one
      // about a model that cannot see, so they are passed through as they are.
      throw new FileReadError(error.message);
    }
    onProgress(read.length, total);
  };

  if (file.type.startsWith("image/") || !file.name.toLowerCase().endsWith(".pdf")) {
    await page(await imageDataUrl(file), 0);
  } else {
    await renderPdfPages(file, total, page, signal);
  }

  const text = pdfPagesToText(read, "ocr");
  // Every page came back blank, which the model treats as "nothing written".
  if (!text.body) {
    throw new FileReadError("画像から文字を読み取れませんでした。");
  }
  return { ...text, truncated: pages > total };
}
