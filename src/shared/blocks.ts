import { DEFAULT_BODY_PT, DEFAULT_FONT_NAME, DEFAULT_TITLE_PT } from "./constants";

export type BlockType = "title" | "heading" | "body" | "clause" | "item" | "center" | "right";

export const BLOCK_TYPES: BlockType[] = [
  "title",
  "heading",
  "body",
  "clause",
  "item",
  "center",
  "right",
];

export type DraftBlock = {
  type: BlockType;
  text: string;
  label?: string;
};

export type TextRun = {
  text: string;
  bold: boolean;
};

export type ParagraphAlignment = "left" | "center" | "right";

export type ParagraphSpec = {
  type: BlockType;
  alignment: ParagraphAlignment;
  fontName: string;
  fontSize: number;
  bold: boolean;
  firstLineIndentPt: number;
  leftIndentPt: number;
  runs: TextRun[];
};

export type FontOptions = {
  fontName?: string;
  bodyPt?: number;
  titlePt?: number;
};

export type Severity = "high" | "medium" | "low";

function isBlockType(value: unknown): value is BlockType {
  return typeof value === "string" && (BLOCK_TYPES as string[]).includes(value);
}

export function normalizeBlock(block: {
  type?: unknown;
  text?: unknown;
  label?: unknown;
}): DraftBlock | null {
  if (typeof block.text !== "string") {
    return null;
  }
  const type: BlockType = isBlockType(block.type) ? block.type : "body";
  const label = typeof block.label === "string" && block.label.trim() ? block.label : undefined;
  return { type, text: block.text, label };
}

function clauseRuns(block: DraftBlock): TextRun[] {
  const label = (block.label || "").trim();
  const text = block.text || "";
  if (!label) {
    return [{ text, bold: false }];
  }
  if (text.startsWith(label)) {
    return [
      { text: label, bold: true },
      { text: text.slice(label.length), bold: false },
    ];
  }
  return [
    { text: label, bold: true },
    { text: `\u3000${text}`, bold: false },
  ];
}

/**
 * Map draft block JSON to Word paragraph/font descriptors.
 * The task pane applies these via Word paragraph + font APIs (not OOXML).
 */
export function mapBlockToParagraph(block: DraftBlock, options: FontOptions = {}): ParagraphSpec {
  const fontName = options.fontName || DEFAULT_FONT_NAME;
  const bodyPt = options.bodyPt || DEFAULT_BODY_PT;
  const titlePt = options.titlePt || DEFAULT_TITLE_PT;
  const em = bodyPt;

  switch (block.type) {
    case "title":
      return {
        type: "title",
        alignment: "center",
        fontName,
        fontSize: titlePt,
        bold: true,
        firstLineIndentPt: 0,
        leftIndentPt: 0,
        runs: [{ text: block.text, bold: true }],
      };
    case "heading":
      return {
        type: "heading",
        alignment: "left",
        fontName,
        fontSize: bodyPt,
        bold: true,
        firstLineIndentPt: 0,
        leftIndentPt: 0,
        runs: [{ text: block.text, bold: true }],
      };
    case "body":
      return {
        type: "body",
        alignment: "left",
        fontName,
        fontSize: bodyPt,
        bold: false,
        firstLineIndentPt: em,
        leftIndentPt: 0,
        runs: [{ text: block.text, bold: false }],
      };
    case "clause":
      return {
        type: "clause",
        alignment: "left",
        fontName,
        fontSize: bodyPt,
        bold: false,
        firstLineIndentPt: 0,
        leftIndentPt: 0,
        runs: clauseRuns(block),
      };
    case "item":
      return {
        type: "item",
        alignment: "left",
        fontName,
        fontSize: bodyPt,
        bold: false,
        firstLineIndentPt: 0,
        leftIndentPt: em,
        runs: [{ text: block.text, bold: false }],
      };
    case "center":
      return {
        type: "center",
        alignment: "center",
        fontName,
        fontSize: bodyPt,
        bold: false,
        firstLineIndentPt: 0,
        leftIndentPt: 0,
        runs: [{ text: block.text, bold: false }],
      };
    case "right":
      return {
        type: "right",
        alignment: "right",
        fontName,
        fontSize: bodyPt,
        bold: false,
        firstLineIndentPt: 0,
        leftIndentPt: 0,
        runs: [{ text: block.text, bold: false }],
      };
    default:
      return {
        type: "body",
        alignment: "left",
        fontName,
        fontSize: bodyPt,
        bold: false,
        firstLineIndentPt: em,
        leftIndentPt: 0,
        runs: [{ text: block.text, bold: false }],
      };
  }
}

export function mapBlocks(blocks: DraftBlock[], options: FontOptions = {}): ParagraphSpec[] {
  return blocks.map((block) => mapBlockToParagraph(block, options));
}

export function specPlainText(spec: ParagraphSpec): string {
  return spec.runs.map((run) => run.text).join("");
}

function shorten(text: string, chars: number): string {
  const trimmed = (text || "").replace(/\s+/g, " ").trim();
  return trimmed.length > chars ? `${trimmed.slice(0, chars)}…` : trimmed;
}

function clauseLabel(block: DraftBlock): string {
  const label = (block.label || "").trim();
  if (label) {
    return label;
  }
  return shorten(block.text, 12);
}

/**
 * Where the insert actually started. Widens `InsertAtArg` in tools.ts (which
 * imports from this file) with the quoted-paragraph case.
 */
export type InsertPlacement = "cursor" | "continue" | "end" | "quote";

/**
 * What the insert landed on. `after` is the paragraph the new text now follows,
 * which is the only way the model can tell it aimed at the wrong paragraph.
 */
export type InsertLanding = { placement: InsertPlacement; after: string };

function placementLabel(placement: InsertPlacement): string {
  switch (placement) {
    case "quote":
      return "引用した段落の後ろに入れました";
    case "end":
      return "文書の末尾に入れました";
    case "continue":
      return "直前に挿入した段落の続きに入れました";
    default:
      return "カーソル位置に入れました";
  }
}

/** Short status for the tool result so the model knows where to continue. */
export function summarizeInsertedBlocks(
  blocks: DraftBlock[],
  landing: InsertLanding = { placement: "cursor", after: "" }
): string {
  const count = `${blocks.length} 段落を挿入しました`;
  const clauses = blocks.filter((block) => block.type === "clause").map(clauseLabel);
  const title = blocks.find((block) => block.type === "title");
  const span = clauses.length
    ? clauses.length === 1
      ? clauses[0]
      : `${clauses[0]}〜${clauses[clauses.length - 1]}`
    : title
      ? `「${shorten(title.text, 20)}」`
      : "";
  const parts = [span ? `${count}（${span}）` : count, placementLabel(landing.placement)];
  const after = shorten(landing.after, 24);
  if (after) {
    parts.push(`前の段落は「${after}」です`);
  }
  const tail = shorten(blocks[blocks.length - 1]?.text || "", 20);
  if (tail) {
    parts.push(`入れた末尾は「${tail}」です`);
  }
  parts.push(
    '意図と違う場所なら、続けずに報告してください。続きは at を "continue" にして足します'
  );
  return `${parts.join("。")}`;
}
