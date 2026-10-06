import { DEFAULT_BODY_PT, DEFAULT_FONT_NAME, DEFAULT_LINE_SPACING_CHARS, DEFAULT_TITLE_PT, lineSpacingPt } from "./constants";
import { BlockFormat } from "./typography";

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
  /** Far-east face. Falls back to `fontName` when absent. */
  fontNameFarEast?: string;
  fontSize: number;
  bold: boolean;
  firstLineIndentPt: number;
  leftIndentPt: number;
  /** Exact line box, in points. One 字 is this paragraph's font size. */
  lineSpacingPt: number;
  /** Omitted means write the font. `false` leaves the inserted paragraph's face. */
  applyFont?: boolean;
  /** Omitted means write the size. */
  applySize?: boolean;
  /** Omitted means write the point indents. */
  applyIndent?: boolean;
  /**
   * Omitted means exact `lineSpacingPt`. `keep` writes nothing.
   * `copy` writes `spacingCopy` and turns snap-to-grid off.
   */
  spacingKind?: "exact" | "copy" | "keep";
  spacingCopy?: { line: string | null; lineRule: string | null };
  runs: TextRun[];
};

export type FontOptions = {
  fontName?: string;
  bodyPt?: number;
  titlePt?: number;
  lineSpacingChars?: number;
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
  const chars = options.lineSpacingChars ?? DEFAULT_LINE_SPACING_CHARS;
  const em = bodyPt;
  const finish = (spec: Omit<ParagraphSpec, "lineSpacingPt">): ParagraphSpec => ({
    ...spec,
    lineSpacingPt: lineSpacingPt(spec.fontSize, chars),
  });

  switch (block.type) {
    case "title":
      return finish({
        type: "title",
        alignment: "center",
        fontName,
        fontSize: titlePt,
        bold: true,
        firstLineIndentPt: 0,
        leftIndentPt: 0,
        runs: [{ text: block.text, bold: true }],
      });
    case "heading":
      return finish({
        type: "heading",
        alignment: "left",
        fontName,
        fontSize: bodyPt,
        bold: true,
        firstLineIndentPt: 0,
        leftIndentPt: 0,
        runs: [{ text: block.text, bold: true }],
      });
    case "body":
      return finish({
        type: "body",
        alignment: "left",
        fontName,
        fontSize: bodyPt,
        bold: false,
        firstLineIndentPt: em,
        leftIndentPt: 0,
        runs: [{ text: block.text, bold: false }],
      });
    case "clause":
      return finish({
        type: "clause",
        alignment: "left",
        fontName,
        fontSize: bodyPt,
        bold: false,
        firstLineIndentPt: 0,
        leftIndentPt: 0,
        runs: clauseRuns(block),
      });
    case "item":
      return finish({
        type: "item",
        alignment: "left",
        fontName,
        fontSize: bodyPt,
        bold: false,
        firstLineIndentPt: 0,
        leftIndentPt: em,
        runs: [{ text: block.text, bold: false }],
      });
    case "center":
      return finish({
        type: "center",
        alignment: "center",
        fontName,
        fontSize: bodyPt,
        bold: false,
        firstLineIndentPt: 0,
        leftIndentPt: 0,
        runs: [{ text: block.text, bold: false }],
      });
    case "right":
      return finish({
        type: "right",
        alignment: "right",
        fontName,
        fontSize: bodyPt,
        bold: false,
        firstLineIndentPt: 0,
        leftIndentPt: 0,
        runs: [{ text: block.text, bold: false }],
      });
    default:
      return finish({
        type: "body",
        alignment: "left",
        fontName,
        fontSize: bodyPt,
        bold: false,
        firstLineIndentPt: em,
        leftIndentPt: 0,
        runs: [{ text: block.text, bold: false }],
      });
  }
}

export function mapBlocks(blocks: DraftBlock[], options: FontOptions = {}): ParagraphSpec[] {
  return blocks.map((block) => mapBlockToParagraph(block, options));
}

/** Overlay one block's resolved face onto a spec built from settings. */
export function paintParagraph(spec: ParagraphSpec, format: BlockFormat): ParagraphSpec {
  const next: ParagraphSpec = {
    ...spec,
    runs: spec.runs.map((run) => ({ ...run })),
  };
  if (format.font.write) {
    next.fontName = format.font.name;
    next.fontNameFarEast = format.font.nameFarEast;
    next.applyFont = true;
  } else {
    next.applyFont = false;
  }
  if (format.size.write) {
    next.fontSize = format.size.pt;
    next.applySize = true;
  } else {
    next.applySize = false;
  }
  if (format.applyIndent) {
    next.applyIndent = true;
    if (spec.type === "body") {
      next.firstLineIndentPt = format.indentEm;
    }
    if (spec.type === "item") {
      next.leftIndentPt = format.indentEm;
    }
  } else {
    next.applyIndent = false;
  }
  if (format.spacing.kind === "exact") {
    next.spacingKind = "exact";
    next.lineSpacingPt = format.spacing.pt;
  } else if (format.spacing.kind === "copy") {
    next.spacingKind = "copy";
    next.spacingCopy = { line: format.spacing.line, lineRule: format.spacing.lineRule };
    next.lineSpacingPt = 0;
  } else {
    next.spacingKind = "keep";
    next.lineSpacingPt = 0;
  }
  return next;
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
export type InsertPlacement = "cursor" | "continue" | "end" | "quote" | "paragraph";

/** A paragraph the insert created, under the number this turn can point at it by. */
export type InsertedParagraph = { number: number; text: string };

/**
 * What the insert landed on. `after` is the paragraph the new text now follows,
 * which is the only way the model can tell it aimed at the wrong paragraph.
 * `numbers` are the addresses handed out for the new paragraphs: they were not
 * in the attachment, so without these the model can only quote them, and short
 * items like 「数量　○○」 recur too often to quote.
 */
export type InsertLanding = {
  placement: InsertPlacement;
  after: string;
  numbers?: InsertedParagraph[];
};

const NUMBERED_LINE_CHARS = 30;

function placementLabel(placement: InsertPlacement): string {
  switch (placement) {
    case "paragraph":
      return "指定した段落の後ろに入れました";
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
    '意図と違う場所なら、続けずに報告してください。続きは at を "continue" にして足します（変更履歴に記録）'
  );
  const summary = `${parts.join("。")}。`;
  if (!landing.numbers?.length) {
    return summary;
  }
  // Kept as written (full-width spaces included): the model may quote from it.
  const lines = landing.numbers.map((row) => {
    const text = row.text.trim();
    const clipped = text.length > NUMBERED_LINE_CHARS ? `${text.slice(0, NUMBERED_LINE_CHARS)}…` : text;
    return `[${row.number}] ${clipped}`;
  });
  return (
    `${summary}\n入れた段落の番号は次のとおりです。このターンでこれらの段落を指すときは、` +
    `quote ではなくこの番号を paragraph / through に渡してください。\n${lines.join("\n")}`
  );
}
