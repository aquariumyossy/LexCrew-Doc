import { FileText } from "../fileSource";
import { plainFileText } from "./plain";
import { scanXml, xmlAttr } from "./xml";

/** The parts of an `.xlsx` worth reading. Cell comments are left out, as in Argos. */
export type SheetParts = {
  /** `xl/sharedStrings.xml`; absent when no cell holds a shared string. */
  sharedStrings?: string;
  /** Worksheets in workbook order. */
  sheets: { name: string; xml: string }[];
};

/** `<si>` entries in order; a cell of type `s` indexes into this. */
export function readSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  let current: string[] | null = null;

  for (const event of scanXml(xml)) {
    if (event.kind === "text") {
      // `rPh` holds furigana for the cell above it, which would double the text.
      if (current && stack[stack.length - 1] === "t" && !stack.includes("rPh")) {
        current.push(event.text);
      }
      continue;
    }
    if (event.kind === "close") {
      const found = stack.lastIndexOf(event.name);
      if (found >= 0) {
        stack.length = found;
      }
      if (event.name === "si" && current) {
        out.push(current.join(""));
        current = null;
      }
      continue;
    }
    if (event.name === "si") {
      if (event.empty) {
        out.push("");
      } else {
        current = [];
      }
    }
    if (!event.empty) {
      stack.push(event.name);
    }
  }
  return out;
}

function readRows(xml: string, shared: string[]): string[] {
  const rows: string[] = [];
  const stack: string[] = [];
  let cells: string[] = [];
  let cellType = "";
  let value: string[] | null = null;

  const finishCell = () => {
    if (value === null) {
      return;
    }
    const raw = value.join("");
    value = null;
    if (cellType === "s") {
      const index = Number.parseInt(raw, 10);
      cells.push(Number.isInteger(index) ? shared[index] || "" : "");
      return;
    }
    if (cellType === "b") {
      cells.push(raw === "1" ? "TRUE" : "FALSE");
      return;
    }
    cells.push(raw);
  };

  for (const event of scanXml(xml)) {
    if (event.kind === "text") {
      const leaf = stack[stack.length - 1];
      if (value && (leaf === "v" || leaf === "t")) {
        value.push(event.text);
      }
      continue;
    }
    if (event.kind === "close") {
      const found = stack.lastIndexOf(event.name);
      if (found >= 0) {
        stack.length = found;
      }
      if (event.name === "c") {
        finishCell();
      }
      if (event.name === "row") {
        const line = cells.join("\t").replace(/\t+$/, "");
        if (line.trim()) {
          rows.push(line);
        }
        cells = [];
      }
      continue;
    }
    if (event.name === "c") {
      cellType = xmlAttr(event.attrs, "t");
      value = event.empty ? null : [];
      if (event.empty) {
        cells.push("");
      }
    }
    if (!event.empty) {
      stack.push(event.name);
    }
  }
  return rows;
}

export function extractSheet(parts: SheetParts): FileText {
  const shared = parts.sharedStrings ? readSharedStrings(parts.sharedStrings) : [];
  const blocks: string[] = [];
  for (const sheet of parts.sheets) {
    const rows = readRows(sheet.xml, shared);
    if (!rows.length) {
      continue;
    }
    blocks.push([`## ${sheet.name}`, ...rows].join("\n"));
  }
  return plainFileText(blocks.join("\n\n"));
}
