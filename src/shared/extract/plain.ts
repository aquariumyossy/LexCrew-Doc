import { emptyMarkup } from "../attachment";
import { FileReadError } from "../fileExtract";
import { FileOrigin, FileText } from "../fileSource";
import { scanXml } from "./xml";

/* global TextDecoder */

/**
 * A file with no notion of comments or tracked changes. The lists stay empty
 * rather than saying "could not read": nothing was there to read.
 */
export function plainFileText(body: string, origin: FileOrigin = "text"): FileText {
  return {
    origin,
    body: body.trim(),
    comments: emptyMarkup(),
    changes: emptyMarkup(),
    truncated: false,
  };
}

/**
 * Text files must be UTF-8. Guessing an encoding turns a Shift-JIS contract into
 * plausible-looking nonsense, which is worse than refusing it.
 */
export function decodeUtf8(bytes: ArrayBuffer | Uint8Array): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    // `fatal` throws a bare `TypeError`, which says nothing to the user and is
    // indistinguishable from any other one thrown along the way.
    throw new FileReadError("文字コードが UTF-8 ではありません。UTF-8 で保存し直してください。");
  }
  // A BOM would otherwise show up as the first character of the body.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const SKIPPED_HTML = new Set(["script", "style", "head", "noscript", "template"]);
const HTML_BREAKS = new Set([
  "p",
  "br",
  "div",
  "li",
  "tr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "section",
  "article",
  "blockquote",
  "pre",
  "table",
]);

export function htmlToText(html: string): string {
  const out: string[] = [];
  const skipped: string[] = [];

  for (const event of scanXml(html)) {
    if (event.kind === "text") {
      if (!skipped.length) {
        out.push(event.text);
      }
      continue;
    }
    const name = event.name.toLowerCase();
    if (SKIPPED_HTML.has(name)) {
      if (event.kind === "open" && !event.empty) {
        skipped.push(name);
      } else if (event.kind === "close") {
        const found = skipped.lastIndexOf(name);
        if (found >= 0) {
          skipped.length = found;
        }
      }
      continue;
    }
    if (HTML_BREAKS.has(name)) {
      out.push("\n");
    } else if (event.kind === "open" && (name === "td" || name === "th")) {
      // Only on the way in: a cell separator on both sides would double up.
      out.push("\t");
    }
  }

  // A close and the next open both ask for a break, so runs collapse to one.
  return out
    .join("")
    .replace(/[^\S\n\t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n+/g, "\n")
    .trim();
}

/**
 * A PDF with nothing on its text layer is a scan. One readable character is
 * enough to trust the layer: a hybrid file's stray glyphs are the author's
 * choice, and rasterising a file that already carries text costs a vision call
 * per page for no gain.
 */
export function pdfHasTextLayer(pages: string[]): boolean {
  return pages.some((page) => page.trim().length > 0);
}

export function pdfPagesToText(pages: string[], origin: FileOrigin = "text"): FileText {
  const body = pages
    .map((page) => page.replace(/[ \t]+\n/g, "\n").trim())
    .filter((page) => page.length > 0)
    .join("\n\n");
  return plainFileText(body, origin);
}
