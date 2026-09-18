import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

/* global URL, window */

/**
 * The worker is copied beside the task pane by webpack rather than pulled from
 * a CDN: an Office add-in may not reach the network, and the legacy build is
 * the one transpiled far enough back for whatever Edge the host embeds.
 * Named `.js` so the host serves it as script however it guesses types.
 *
 * Absolute, because pdf.js falls back to running the worker on the main thread
 * by importing this same path as a module, and a browser rejects a bare
 * specifier there. With the URL spelled out, a task pane whose WebView refuses
 * workers still reads the PDF, only slower.
 */
GlobalWorkerOptions.workerSrc = new URL("assets/pdf.worker.js", window.location.href).href;

/**
 * Everything pdf.js keeps outside its bundle, copied beside the task pane by
 * webpack. `getFactoryUrlProp` refuses a path without a trailing slash.
 */
const PDF_ASSETS = new URL("assets/pdf/", window.location.href).href;

/**
 * The document with the way to release it. Closing lives on the loading task
 * rather than the document, which is easy to forget and leaves a worker behind.
 */
export type PdfHandle = {
  doc: PDFDocumentProxy;
  close: () => Promise<void>;
};

export async function openPdf(bytes: ArrayBuffer): Promise<PdfHandle> {
  const task = getDocument({
    data: new Uint8Array(bytes),
    // A Japanese PDF is usually CID-keyed against a predefined CMap, and
    // without these the text layer comes back as the wrong characters or as
    // nothing, which then looks like a scan and goes to the model as an image.
    cMapUrl: `${PDF_ASSETS}cmaps/`,
    standardFontDataUrl: `${PDF_ASSETS}standard_fonts/`,
    // JBIG2 and JPEG 2000 live in wasm since pdf.js 6, and a scan from a
    // copier is often one of the two. Missing, its pages rasterise blank.
    wasmUrl: `${PDF_ASSETS}wasm/`,
    iccUrl: `${PDF_ASSETS}iccs/`,
  });
  const doc = await task.promise;
  return { doc, close: () => task.destroy() };
}

/** One string per page, in page order, so an empty layer is visible as such. */
export async function readPdfPages(doc: PDFDocumentProxy, maxChars: number): Promise<string[]> {
  const pages: string[] = [];
  let used = 0;
  for (let number = 1; number <= doc.numPages; number += 1) {
    if (used >= maxChars) {
      break;
    }
    const page = await doc.getPage(number);
    try {
      const content = await page.getTextContent();
      const parts: string[] = [];
      for (const item of content.items) {
        if (!("str" in item)) {
          continue;
        }
        parts.push(item.str);
        if (item.hasEOL) {
          parts.push("\n");
        }
      }
      const text = parts.join("").slice(0, Math.max(0, maxChars - used));
      pages.push(text);
      used += text.length;
    } finally {
      page.cleanup();
    }
  }
  return pages;
}
