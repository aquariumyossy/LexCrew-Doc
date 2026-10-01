import JSZip from "jszip";
import { MAX_FILE_CHARS } from "../../shared/constants";
import { extractDocx } from "../../shared/extract/docx";
import {
  decodeUtf8,
  htmlToText,
  pdfHasTextLayer,
  pdfPagesToText,
  plainFileText,
} from "../../shared/extract/plain";
import { extractSheet } from "../../shared/extract/sheet";
import { xmlAttr, scanXml } from "../../shared/extract/xml";
import { FileReadError, fileKind } from "../../shared/fileExtract";
import { FileText, capFileText } from "../../shared/fileSource";
import { openPdf, readPdfPages } from "./pdf";

/* global File */

/**
 * A file either gives up its text here, or turns out to be a picture of text
 * and has to go through a vision read. Nothing in between: the task pane never
 * holds a half-extracted file.
 */
export type FileRead = { status: "text"; text: FileText } | { status: "scan"; pages: number };

/**
 * Names the format that failed and keeps what the library said. pdf.js and
 * JSZip throw in the words of their own internals, and a badge reading
 * "読み取りに失敗しました" with nothing else is unreportable.
 */
async function reading<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof FileReadError) {
      throw error;
    }
    const detail = error instanceof Error && error.message ? error.message : String(error);
    throw new FileReadError(`${label}を読めませんでした（${detail}）`);
  }
}

async function zipText(zip: JSZip, path: string): Promise<string> {
  const entry = zip.file(path);
  return entry ? entry.async("string") : "";
}

async function readDocx(bytes: ArrayBuffer): Promise<FileText> {
  const zip = await JSZip.loadAsync(bytes);
  const document = await zipText(zip, "word/document.xml");
  if (!document) {
    throw new FileReadError("Word の本文が見つかりませんでした。");
  }
  return extractDocx({
    document,
    comments: await zipText(zip, "word/comments.xml"),
    numbering: await zipText(zip, "word/numbering.xml"),
    styles: await zipText(zip, "word/styles.xml"),
  });
}

/** Sheet order comes from the workbook, not from the file names inside the zip. */
function workbookSheets(workbook: string): { name: string; rid: string }[] {
  const out: { name: string; rid: string }[] = [];
  for (const event of scanXml(workbook)) {
    if (event.kind === "open" && event.name.replace(/^.*:/, "") === "sheet") {
      const name = xmlAttr(event.attrs, "name");
      const rid = xmlAttr(event.attrs, "r:id") || xmlAttr(event.attrs, "id");
      if (rid) {
        out.push({ name, rid });
      }
    }
  }
  return out;
}

function relationshipTargets(rels: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const event of scanXml(rels)) {
    if (event.kind === "open" && event.name.replace(/^.*:/, "") === "Relationship") {
      const id = xmlAttr(event.attrs, "Id");
      const target = xmlAttr(event.attrs, "Target");
      if (id && target) {
        out.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
      }
    }
  }
  return out;
}

async function readSheet(bytes: ArrayBuffer): Promise<FileText> {
  const zip = await JSZip.loadAsync(bytes);
  const workbook = await zipText(zip, "xl/workbook.xml");
  if (!workbook) {
    throw new FileReadError("Excel のブックが見つかりませんでした。");
  }
  const targets = relationshipTargets(await zipText(zip, "xl/_rels/workbook.xml.rels"));
  const sheets: { name: string; xml: string }[] = [];
  for (const sheet of workbookSheets(workbook)) {
    const path = targets.get(sheet.rid);
    if (!path) {
      continue;
    }
    const xml = await zipText(zip, path);
    if (xml) {
      sheets.push({ name: sheet.name, xml });
    }
  }
  return extractSheet({ sharedStrings: await zipText(zip, "xl/sharedStrings.xml"), sheets });
}

async function readPdf(bytes: ArrayBuffer): Promise<FileRead> {
  const handle = await openPdf(bytes);
  try {
    const pages = await readPdfPages(handle.doc, MAX_FILE_CHARS);
    if (!pdfHasTextLayer(pages)) {
      return { status: "scan", pages: handle.doc.numPages };
    }
    return { status: "text", text: pdfPagesToText(pages) };
  } finally {
    await handle.close();
  }
}

/**
 * Reads one picked file. The bytes are pulled from the handle here and dropped
 * on the way out: only the extracted text is kept, so a 20MB scan does not sit
 * beside the document for the rest of the conversation.
 */
export async function readFile(file: File): Promise<FileRead> {
  const kind = fileKind(file.name);
  if (kind === "image") {
    // A picture has no text layer to try, so it goes straight to a vision read.
    return { status: "scan", pages: 1 };
  }
  const bytes = await reading("ファイル", () => file.arrayBuffer());
  if (kind === "pdf") {
    return reading("PDF", () => readPdf(bytes));
  }
  if (kind === "docx") {
    const text = await reading("Word", () => readDocx(bytes));
    return { status: "text", text: capFileText(text, MAX_FILE_CHARS) };
  }
  if (kind === "sheet") {
    const text = await reading("Excel", () => readSheet(bytes));
    return { status: "text", text: capFileText(text, MAX_FILE_CHARS) };
  }
  const decoded = decodeUtf8(bytes);
  const body = kind === "html" ? htmlToText(decoded) : decoded;
  return { status: "text", text: capFileText(plainFileText(body), MAX_FILE_CHARS) };
}
