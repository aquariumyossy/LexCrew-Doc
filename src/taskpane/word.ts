import {
  Attachment,
  AttachmentScope,
  ChangeKind,
  ChangeNote,
  CommentNote,
  EMPTY_ATTACHMENT,
  EMPTY_SHAPES,
  ShapeRead,
  MAX_ANCHOR_CHARS,
  MAX_CHANGE_TEXT_CHARS,
  MAX_CHANGE_WHERE_CHARS,
  MAX_COMMENT_BODY_CHARS,
  MAX_REPLY_CHARS,
  MarkupList,
  changeChars,
  clipNote,
  commentChars,
  emptyMarkup,
  markupCharBudget,
} from "../shared/attachment";
import {
  InsertLanding,
  InsertPlacement,
  InsertedParagraph,
  ParagraphSpec,
  Severity,
  paintParagraph,
  specPlainText,
} from "../shared/blocks";
import { MAX_CHANGES_READ, MAX_COMMENTS_READ, MAX_COMMENT_CHARS } from "../shared/constants";
import {
  MAX_REPLACE_MATCHES,
  compileParagraphMatcher,
  planTextMatches,
  type ParagraphFact,
  type TextMatch,
} from "../shared/bulkFormat";
import {
  LineSpacingCopy,
  ParagraphFormatOptions,
  patchParagraphFormat,
  readParagraphLineSpacing,
} from "../shared/lineGrid";
import {
  SAMPLE_RADIUS,
  FaceReading,
  ResolvedInsert,
  SampledParagraph,
  SettingsFormat,
  UserFormat,
  resolveInsertFormats,
} from "../shared/typography";
import {
  commentsXmlFromPackage,
  documentXmlFromPackage,
  MARKUP_LEGEND,
  neutralizeLiteralMarkup,
  readMarkupBody,
  stripInlineMarkup,
} from "../shared/markupText";
import {
  fitShapeText,
  pickShapeByText,
  readShapeBlocks,
  renderedShapeBody,
} from "../shared/extract/shapeText";
import { SHAPES_MARKER, TRUNCATION_NOTE } from "../shared/prompts";
import { formatParagraphRef, isParagraphRef } from "../shared/paragraphRef";
import { alignReviewed, opHitsDeletion, planRedline, type RedlineOp, type ReviewedAlignment } from "../shared/redline";
import {
  formatAttachedLine,
  formatSelectionLine,
  LIST_MARK_AVG_CHARS,
  ListMark,
  isBulletMark,
  isNumberMark,
  stripListMarks,
  wrapListMark,
} from "../shared/listMark";
import {
  isBuiltinListStyle,
  listLevelNumberFormat,
  listStyleNamesForApply,
  listStyleSpec,
  type ListStyle,
} from "../shared/listStyles";
import {
  ApplyFormatArgs,
  CopyFormatArgs,
  DeleteParagraphsArgs,
  DeleteShapeArgs,
  FindInDocumentArgs,
  FormatListArgs,
  FormatParagraphArgs,
  FormatTextArgs,
  InsertAtArg,
  ParagraphFormatFields,
  ReplaceAllArgs,
  TextFormatFields,
  InsertCommentArgs,
  MAX_FIND_CHARS,
  ReadParagraphsArgs,
  ReplaceQuoteArgs,
  SetOutlineArgs,
} from "../shared/tools";
import { SearchHit } from "../sidecar/types";

/* global Office, Word */

/** Word's search string cannot exceed this, and cannot span paragraphs. */
const MAX_SEARCH_CHARS = 255;

/**
 * Where the last add-in insert ended. A bookmark survives syncs, turns and the
 * user clicking elsewhere, which the Word selection does not.
 * Name rules: 1-40 chars, must start with a letter, letters/digits/underscore.
 */
const DRAFT_TAIL_BOOKMARK = "guri_draft_tail";

function truncateComment(text: string): string {
  if (text.length <= MAX_COMMENT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_COMMENT_CHARS - 1)}…`;
}

function severityLabel(severity: Severity): string {
  if (severity === "high") {
    return "高";
  }
  if (severity === "low") {
    return "低";
  }
  return "中";
}

function formatComment(comment: string, severity: Severity): string {
  return `【${severityLabel(severity)}】${comment.trim()}\n\n※ LLM出力のため、判例・条文の引用は未確認です。`;
}

function formatCitation(hit: SearchHit): string {
  const snippet = hit.content.trim() ? `\n${hit.content.trim()}` : "";
  return `【出典】${hit.title}\n${hit.url}${snippet}`;
}

/** True when any of the first paragraphs has text. Selection-only turns use this. */
export async function documentHasVisibleText(limit = 40): Promise<boolean> {
  if (!isWordHost()) {
    return false;
  }
  try {
    return await Word.run(async (context) => {
      let current = context.document.body.paragraphs.getFirstOrNullObject();
      await context.sync();
      for (let i = 0; i < limit; i += 1) {
        if (current.isNullObject) {
          return false;
        }
        current.load("text");
        await context.sync();
        if ((current.text || "").trim()) {
          return true;
        }
        current = current.getNextOrNullObject();
        await context.sync();
      }
      return false;
    });
  } catch {
    return false;
  }
}

export function isWordHost(): boolean {
  try {
    return typeof Office !== "undefined" && Office.context?.host === Office.HostType.Word;
  } catch {
    return false;
  }
}

function verticalFromOoxml(xml: string): boolean {
  return /w:val="tbRl"/i.test(xml) || /w:val="btLr"/i.test(xml) || /w:val="tbLrV"/i.test(xml);
}

export async function assertDocumentReady(): Promise<void> {
  if (typeof Office === "undefined") {
    throw new Error("Office.js が読み込めていません。Word デスクトップで開き直してください。");
  }
  if (Office.context.host !== Office.HostType.Word) {
    throw new Error("Word デスクトップの作業ウィンドウで実行してください。");
  }
  if (!Office.context.requirements.isSetSupported("WordApi", "1.4")) {
    throw new Error(
      "WordApi 1.4 以上の Word デスクトップが必要です（概ね 2022年8月以降の Microsoft 365）。Word on the web は対象外です。"
    );
  }
  if (Office.context.document.mode === Office.DocumentMode.ReadOnly) {
    throw new Error(
      "読み取り専用または保護ビューです。横書きの .docx を編集モードで開いてください。"
    );
  }

  const url = Office.context.document.url || "";
  if (url && /\.(doc|rtf|odt)$/i.test(url) && !/\.docx$/i.test(url)) {
    throw new Error(".doc など古い形式は対象外です。横書きの .docx を開いてください。");
  }

  await Word.run(async (context) => {
    // Only the first paragraph is needed; loading them all costs seconds on a
    // long contract, and this runs before every turn.
    const first = context.document.body.paragraphs.getFirstOrNullObject();
    await context.sync();
    if (first.isNullObject) {
      return;
    }
    const ooxml = first.getOoxml();
    await context.sync();
    // getOoxml returns a ClientResult, which the sync above fills in; the rule
    // sees the null-object paragraph and asks for a load that does not exist.
    // eslint-disable-next-line office-addins/load-object-before-read
    if (verticalFromOoxml(ooxml.value || "")) {
      throw new Error("縦書き文書は対象外です。横書きの .docx を開いてください。");
    }
  });
}

/** Tracked changes arrived in WordApi 1.6; comments are in 1.4, which we require. */
export function canReadChanges(): boolean {
  try {
    return isWordHost() && Office.context.requirements.isSetSupported("WordApi", "1.6");
  } catch {
    return false;
  }
}

/** Reviewed body text is WordApi 1.4, the same floor as comments. */
export function canReadReviewed(): boolean {
  try {
    return isWordHost() && Office.context.requirements.isSetSupported("WordApi", "1.4");
  } catch {
    return false;
  }
}

function canSeparateList(): boolean {
  try {
    return isWordHost() && Office.context.requirements.isSetSupported("WordApiDesktop", "1.4");
  } catch {
    return false;
  }
}

/** Layout page of a range. WordApiDesktop 1.2; older Word simply has no pages. */
function canReadLayoutPage(): boolean {
  try {
    return isWordHost() && Office.context.requirements.isSetSupported("WordApiDesktop", "1.2");
  } catch {
    return false;
  }
}

/** `Shape.delete` is WordApiDesktop 1.2, the same floor as reading a layout page. */
function canDeleteShapes(): boolean {
  try {
    return isWordHost() && Office.context.requirements.isSetSupported("WordApiDesktop", "1.2");
  } catch {
    return false;
  }
}

function canApplyBuiltinListStyles(): boolean {
  try {
    return isWordHost() && Office.context.requirements.isSetSupported("WordApiDesktop", "1.3");
  } catch {
    return false;
  }
}

export type DocumentStats = {
  chars: number;
  /** The body plus its paragraph labels: what the attachment would really cost. */
  attachChars: number;
  comments: number;
  changes: number;
  /** False when this Word is too old to read tracked changes at all. */
  changesAvailable: boolean;
};

/** 「[123] 」 as an average; the meter only needs to stop under-reading. */
const PARAGRAPH_LABEL_CHARS = 6;

/**
 * Sizes for the context meter and the composer readout. Cheap enough to run when
 * the pane opens, after a turn and when the picker opens, but not on every click.
 */
export async function getDocumentStats(): Promise<DocumentStats> {
  const empty = {
    chars: 0,
    attachChars: 0,
    comments: 0,
    changes: 0,
    changesAvailable: canReadChanges(),
  };
  if (!isWordHost()) {
    return empty;
  }
  // The paragraph count comes free with the text: Word ends each one with a
  // carriage return. Loading the paragraph collection would read the body twice.
  // Text boxes are not in body.text. Counting them would read the whole package
  // on every meter refresh, so the meter stays low by that amount.
  const size = await Word.run(async (context) => {
    const body = context.document.body;
    body.load("text");
    const paragraphs = body.paragraphs;
    paragraphs.load("items/isListItem");
    await context.sync();
    const text = body.text || "";
    const numbered = text.split("\r").filter((line) => line.trim()).length;
    let lists = 0;
    try {
      lists = paragraphs.items.filter((paragraph) => paragraph.isListItem).length;
    } catch {
      lists = 0;
    }
    return {
      chars: text.length,
      attachChars: text.length + numbered * PARAGRAPH_LABEL_CHARS + lists * LIST_MARK_AVG_CHARS,
    };
  });
  // Counting markup must not stop the meter: a document with a tracked move can
  // fail the whole tracked-change call (office-js#5535).
  const comments = await Word.run(async (context) => {
    const list = context.document.body.getComments();
    list.load("items/id");
    await context.sync();
    return list.items.length;
  }).catch(() => 0);
  const changes = empty.changesAvailable
    ? await Word.run(async (context) => {
        const list = context.document.body.getTrackedChanges();
        list.load("items/type");
        await context.sync();
        return list.items.length;
      }).catch(() => 0)
    : 0;
  return { ...empty, ...size, comments, changes };
}

export type DocumentText = {
  text: string;
  paragraphs: number;
  truncated: boolean;
  listMarks: boolean;
  shapes: ShapeRead;
};

type AttachedParagraph = {
  /** Raw `paragraph.text`; used to locate a numbered paragraph again. */
  text: string;
  /** What the model sees: reviewed text, or marked text in phase 2. */
  shown: string;
  listString: string;
  isListItem: boolean;
};

/** Every paragraph number to raw text, including blanks skipped from the attachment. */
let allParagraphRawTexts = new Map<number, string>();
/** Set when getReviewedText could not be used for the body this turn. */
let attachmentReviewedFallback = false;
/** Set when inline markup was embedded in the body this turn. */
let attachmentUsesInlineMarkup = false;
/** Inline markup read from the last body read, when phase 2 succeeded. */
let lastInlineChanges: ChangeNote[] = [];
let lastInlineChangesTruncated = false;
let lastInlineAppendixComments: CommentNote[] = [];
let lastInlineCommentCount = 0;

const PARAGRAPH_LABEL = /^\s*\[(\d+)\]\s*/;
const PARAGRAPH_LABEL_ONLY = /^\s*\[(\d+)\]\s*$/;

/**
 * Word ends a paragraph with a carriage return, marks a soft break with a
 * vertical tab and a table cell with a bell.
 */
function paragraphText(paragraph: { text?: string }): string {
  return (paragraph.text || "")
    .replaceAll("\r", "")
    .replaceAll("\u0007", "")
    .replaceAll("\u000b", " ");
}

function listKindOf(paragraph: Word.Paragraph): ListMark["kind"] {
  try {
    const list = paragraph.listOrNullObject;
    if (!list || list.isNullObject) {
      return undefined;
    }
    const types = list.levelTypes as unknown;
    const level = listLevelOf(paragraph);
    const type = Array.isArray(types) ? types[level] : undefined;
    const bullet = (typeof Word !== "undefined" && Word.ListLevelType?.bullet) || "Bullet";
    const number = (typeof Word !== "undefined" && Word.ListLevelType?.number) || "Number";
    if (type === bullet || type === "Bullet" || type === "bullet") {
      return "bullet";
    }
    if (type === number || type === "Number" || type === "number") {
      return "number";
    }
  } catch {
    // Fall back to the listString glyph.
  }
  return undefined;
}

function listMarkOf(paragraph: Word.Paragraph): ListMark {
  try {
    if (!paragraph.isListItem) {
      return { isListItem: false, listString: "" };
    }
  } catch {
    return { isListItem: false, listString: "" };
  }
  try {
    const item = paragraph.listItemOrNullObject;
    if (!item || item.isNullObject) {
      return { isListItem: true, listString: "", kind: listKindOf(paragraph) };
    }
    return {
      isListItem: true,
      listString: item.listString || "",
      kind: listKindOf(paragraph),
    };
  } catch {
    return { isListItem: true, listString: "", kind: listKindOf(paragraph) };
  }
}

async function loadListStrings(
  context: Word.RequestContext,
  paragraphs: Word.Paragraph[]
): Promise<void> {
  const listed: Word.Paragraph[] = [];
  for (const paragraph of paragraphs) {
    try {
      if (paragraph.isListItem) {
        listed.push(paragraph);
      }
    } catch {
      // isListItem unread: treat as not a list.
    }
  }
  if (!listed.length) {
    return;
  }
  try {
    for (const paragraph of listed) {
      paragraph.listItemOrNullObject.load("listString,level");
      paragraph.listOrNullObject.load("id,levelTypes");
    }
    await context.sync();
  } catch {
    // The body still stands. Marks become 〔番号あり〕 or stay off.
  }
}

/**
 * The lines handed to the model this turn, by paragraph number. A number is
 * resolved back through this table rather than used as a plain index: an insert
 * earlier in the document moves everything below it, and the model must not be
 * asked to do that arithmetic while it works.
 */
let attachedParagraphs = new Map<number, AttachedParagraph>();
/** How many paragraphs the document had when those numbers were handed over. */
let attachedParagraphCount = 0;
/**
 * Shape text shown this turn, in `[図1]` order. The strings stay after a delete
 * so a later duplicate still means the same occurrence.
 */
let attachedShapes: string[] = [];
/** `[図]` numbers already deleted this turn. */
let spentShapes = new Set<number>();
/** Shape ids already deleted. Tracked changes may leave them in the collection. */
let deletedShapeIds = new Set<number>();

function forgetParagraphNumbers(): void {
  attachedParagraphs = new Map();
  attachedParagraphCount = 0;
  attachedShapes = [];
  spentShapes = new Set();
  deletedShapeIds = new Set();
  allParagraphRawTexts = new Map();
  attachmentReviewedFallback = false;
  attachmentUsesInlineMarkup = false;
  lastInlineChanges = [];
  lastInlineChangesTruncated = false;
  lastInlineAppendixComments = [];
  lastInlineCommentCount = 0;
}

function resolveLocationText(rawParagraphText: string): string {
  const target = compact(paragraphText({ text: rawParagraphText }));
  if (!target) {
    for (const [number, raw] of allParagraphRawTexts) {
      if (!compact(raw)) {
        return formatParagraphRef(number);
      }
    }
    return clipNote(rawParagraphText, MAX_CHANGE_WHERE_CHARS);
  }
  for (const [number, raw] of allParagraphRawTexts) {
    const dense = compact(raw);
    if (dense === target || (target.length >= 4 && dense.includes(target))) {
      return formatParagraphRef(number);
    }
  }
  for (const [number, row] of attachedParagraphs) {
    const dense = compact(row.text);
    if (dense === target || (target.length >= 4 && dense.includes(target))) {
      return formatParagraphRef(number);
    }
  }
  return clipNote(rawParagraphText, MAX_CHANGE_WHERE_CHARS);
}

function resolveMarkupLocations(
  comments: MarkupList<CommentNote>,
  changes: MarkupList<ChangeNote>
): void {
  for (const note of comments.items) {
    if (note.anchor && !isParagraphRef(note.anchor)) {
      note.anchor = resolveLocationText(note.anchor);
    }
  }
  for (const note of changes.items) {
    if (note.where && !isParagraphRef(note.where)) {
      note.where = resolveLocationText(note.where);
    }
  }
}

type ReadDocumentOptions = {
  markup?: boolean;
  markupBudget?: number;
};

/**
 * The body handed to the model. `shown` is reviewed (or marked) text; `text`
 * on each attached row stays raw so paragraph numbers still resolve through
 * `search`.
 */
function shapeReadWithin(documentXml: string, maxChars: number): ShapeRead {
  const overhead = `\n\n${SHAPES_MARKER}\n`.length;
  const room = Math.max(0, maxChars - overhead);
  const fitted = fitShapeText(readShapeBlocks(documentXml), room, TRUNCATION_NOTE);
  attachedShapes = fitted.shown;
  spentShapes = new Set();
  return {
    text: fitted.text,
    truncated: fitted.truncated,
    error: "",
    count: fitted.shown.length,
  };
}

export async function readDocumentText(
  maxChars: number,
  options: ReadDocumentOptions = {}
): Promise<DocumentText> {
  forgetParagraphNumbers();
  if (!isWordHost() || maxChars <= 0) {
    return { text: "", paragraphs: 0, truncated: false, listMarks: false, shapes: EMPTY_SHAPES };
  }
  return Word.run(async (context) => {
    const paragraphs = context.document.body.paragraphs;
    paragraphs.load("items/text,items/isListItem");
    await context.sync();
    await loadListStrings(context, paragraphs.items);

    const useReviewed = canReadReviewed();
    type ReviewedTextResult = { value: string };
    const reviewed: ReviewedTextResult[] = [];
    if (useReviewed) {
      for (const paragraph of paragraphs.items) {
        reviewed.push(
          paragraph.getReviewedText(Word.ChangeTrackingVersion.current) as ReviewedTextResult
        );
      }
      try {
        await context.sync();
      } catch {
        attachmentReviewedFallback = true;
        reviewed.length = 0;
      }
    } else {
      attachmentReviewedFallback = true;
    }

    let documentXml = "";
    let commentsXml: string | undefined;
    let shapeError = "";
    try {
      const pkg = context.document.body.getOoxml();
      await context.sync();
      const raw = pkg.value || "";
      documentXml = documentXmlFromPackage(raw);
      commentsXml = commentsXmlFromPackage(raw);
    } catch (error) {
      shapeError = readFailed(error);
    }

    let inlineMarked: string[] | null = null;
    let inlineChanges: ChangeNote[] = [];
    let inlineChangesTruncated = false;
    let appendixComments: CommentNote[] = [];
    if (options.markup && !attachmentReviewedFallback && !shapeError) {
      try {
        const parsed = readMarkupBody(documentXml, commentsXml, { skipShapeParagraphs: true });
        if (parsed.paragraphCount === paragraphs.items.length) {
          const overhead = parsed.markupOverhead;
          const budget = options.markupBudget ?? maxChars;
          if (!parsed.hasInlineMarkup || overhead <= budget) {
            inlineMarked = parsed.markedParagraphs;
            inlineChanges = parsed.changes;
            inlineChangesTruncated = parsed.changesTruncated;
            appendixComments = parsed.commentsForAppendix;
            lastInlineCommentCount = parsed.inlineCommentCount;
            attachmentUsesInlineMarkup = parsed.hasInlineMarkup;
          }
        }
      } catch {
        // Fall back to reviewed text without inline markers.
      }
    }

    const shapes = shapeError
      ? { text: "", truncated: false, error: shapeError }
      : shapeReadWithin(documentXml, maxChars);
    const shapeBody = renderedShapeBody(shapes);
    const shapeReserve = shapeBody ? `\n\n${SHAPES_MARKER}\n`.length + shapeBody.length : 0;
    const bodyBudget = Math.max(0, maxChars - shapeReserve);

    const lines: string[] = [];
    const attached = new Map<number, AttachedParagraph>();
    allParagraphRawTexts = new Map();
    let used = 0;
    let truncated = false;
    let listMarks = false;
    let number = 0;
    for (let index = 0; index < paragraphs.items.length; index += 1) {
      const paragraph = paragraphs.items[index];
      number += 1;
      const raw = paragraphText(paragraph);
      allParagraphRawTexts.set(number, raw);
      const reviewedText =
        !attachmentReviewedFallback && reviewed[index]
          ? paragraphText({ text: reviewed[index].value || "" })
          : raw;

      let display = inlineMarked ? inlineMarked[index] ?? reviewedText : neutralizeLiteralMarkup(reviewedText);
      if (!display.trim() && !raw.trim() && !reviewedText.trim()) {
        continue;
      }
      if (!display.trim()) {
        continue;
      }
      const mark = listMarkOf(paragraph);
      const numbered = formatAttachedLine(number, display, mark);
      if (used + numbered.length + 1 > bodyBudget) {
        truncated = true;
        break;
      }
      lines.push(numbered);
      attached.set(number, {
        text: raw,
        shown: display,
        listString: mark.listString,
        isListItem: mark.isListItem,
      });
      if (mark.isListItem) {
        listMarks = true;
      }
      used += numbered.length + 1;
    }

    if (inlineMarked && attachmentUsesInlineMarkup) {
      const legend = `${MARKUP_LEGEND}\n\n`;
      if (used + legend.length <= bodyBudget) {
        lines.unshift(legend.trimEnd());
        used += legend.length;
      }
    }

    attachedParagraphs = attached;
    attachedParagraphCount = paragraphs.items.length;

    if (attachmentUsesInlineMarkup) {
      lastInlineChanges = inlineChanges;
      lastInlineChangesTruncated = inlineChangesTruncated;
      lastInlineAppendixComments = appendixComments;
    }

    return { text: lines.join("\n"), paragraphs: lines.length, truncated, listMarks, shapes };
  });
}

/** Word hands dates over as Date objects; the model only needs the day. */
function isoDay(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return "";
  }
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function readFailed(error: unknown): string {
  return error instanceof Error ? error.message : "理由は分かりません";
}

function markupSource(context: Word.RequestContext, scope: AttachmentScope) {
  return scope === "selection" ? context.document.getSelection() : context.document.body;
}

/** Comments carry the counterparty's asks, so they are read even when short on room. */
async function readComments(
  scope: AttachmentScope,
  budget: number
): Promise<MarkupList<CommentNote>> {
  if (budget <= 0) {
    return { items: [], truncated: true, error: "" };
  }
  try {
    return await Word.run(async (context) => {
      const list = markupSource(context, scope).getComments();
      list.load("items/authorName,items/content,items/creationDate,items/resolved");
      await context.sync();

      const capped = list.items.slice(0, MAX_COMMENTS_READ);
      const anchors = capped.map((comment) => {
        const range = comment.getRange();
        range.load("text");
        return range;
      });
      const threads = capped.map((comment) => {
        const replies = comment.replies;
        replies.load("items/authorName,items/content,items/creationDate");
        return replies;
      });
      // The anchor and the replies are extras: losing them beats losing the comment.
      let detailed = true;
      try {
        await context.sync();
      } catch {
        detailed = false;
      }

      const items: CommentNote[] = [];
      let used = 0;
      let truncated = capped.length < list.items.length;
      for (let index = 0; index < capped.length; index += 1) {
        const comment = capped[index];
        const note: CommentNote = {
          author: comment.authorName || "",
          date: isoDay(comment.creationDate),
          resolved: comment.resolved === true,
          anchor: detailed ? clipNote(anchors[index].text, MAX_ANCHOR_CHARS) : "",
          content: clipNote(comment.content, MAX_COMMENT_BODY_CHARS),
          replies: detailed
            ? threads[index].items.map((reply) => ({
                author: reply.authorName || "",
                date: isoDay(reply.creationDate),
                content: clipNote(reply.content, MAX_REPLY_CHARS),
              }))
            : [],
        };
        const cost = commentChars(note);
        if (used + cost > budget && items.length) {
          truncated = true;
          break;
        }
        items.push(note);
        used += cost;
      }
      return { items, truncated, error: "" };
    });
  } catch (error) {
    return { items: [], truncated: false, error: readFailed(error) };
  }
}

function changeKind(type: string): ChangeKind {
  switch (type) {
    case "Added":
      return "insert";
    case "Deleted":
      return "delete";
    case "Formatted":
      return "format";
    default:
      return "other";
  }
}

/**
 * Tracked changes need WordApi 1.6, and one tracked move can fail the whole call
 * (office-js#5535). Either way the caller must say so rather than show none.
 */
async function readChanges(
  scope: AttachmentScope,
  budget: number
): Promise<MarkupList<ChangeNote>> {
  if (!canReadChanges()) {
    return {
      items: [],
      truncated: false,
      error: "この Word では変更履歴を読めません（WordApi 1.6 以上が必要です）",
    };
  }
  if (budget <= 0) {
    return { items: [], truncated: true, error: "" };
  }
  try {
    return await Word.run(async (context) => {
      const list = markupSource(context, scope).getTrackedChanges();
      list.load("items/author,items/date,items/text,items/type");
      await context.sync();

      const capped = list.items.slice(0, MAX_CHANGES_READ);
      const holders = capped.map((change) => {
        const paragraph = change.getRange().paragraphs.getFirst();
        paragraph.load("text");
        return paragraph;
      });
      // A deletion the body no longer shows is placed by its paragraph, but a
      // range that will not resolve must not cost us the change itself.
      let placed = true;
      try {
        await context.sync();
      } catch {
        placed = false;
      }

      const items: ChangeNote[] = [];
      let used = 0;
      let truncated = capped.length < list.items.length;
      for (let index = 0; index < capped.length; index += 1) {
        const change = capped[index];
        const note: ChangeNote = {
          kind: changeKind(String(change.type || "")),
          author: change.author || "",
          date: isoDay(change.date),
          text: clipNote(change.text, MAX_CHANGE_TEXT_CHARS),
          where: placed ? clipNote(holders[index].text, MAX_CHANGE_WHERE_CHARS) : "",
        };
        const cost = changeChars(note);
        if (used + cost > budget && items.length) {
          truncated = true;
          break;
        }
        items.push(note);
        used += cost;
      }
      return { items, truncated, error: "" };
    });
  } catch (error) {
    return { items: [], truncated: false, error: readFailed(error) };
  }
}

function usedChars<T>(list: MarkupList<T>, cost: (item: T) => number): number {
  return list.items.reduce((total, item) => total + cost(item), 0);
}

/**
 * What rides along with one instruction, read fresh so it matches the document
 * the tools are about to edit. Everything shares one budget, since the model
 * receives it all: the selection, the markup, then the body with what is left.
 */
export async function readAttachment(
  scope: AttachmentScope,
  budget: number,
  markup: boolean
): Promise<Attachment> {
  if (!isWordHost() || scope === "none") {
    // No numbers were handed over, so last turn's must not stay resolvable.
    forgetParagraphNumbers();
    return { ...EMPTY_ATTACHMENT, scope };
  }
  const selected = await readSelectionAttachment();
  const focus = selected.text.slice(0, Math.max(0, budget));
  const focusCut = focus.length < selected.text.length;

  const forMarkup = markup ? markupCharBudget(budget - focus.length) : 0;
  // Comments take half; changes take the rest, which is the denser of the two.
  const comments: MarkupList<CommentNote> = markup
    ? await readComments(scope, Math.floor(forMarkup / 2))
    : emptyMarkup<CommentNote>();
  const commentsUsed = usedChars(comments, commentChars);
  const changes: MarkupList<ChangeNote> = markup
    ? await readChanges(scope, forMarkup - commentsUsed)
    : emptyMarkup<ChangeNote>();
  const markupUsed = commentsUsed + usedChars(changes, changeChars);

  if (scope === "selection") {
    forgetParagraphNumbers();
    if (markup) {
      resolveMarkupLocations(comments, changes);
    }
    return {
      scope,
      document: "",
      paragraphs: 0,
      truncated: focusCut,
      focus,
      markup,
      comments,
      changes,
      listMarks: selected.listMarks,
      reviewedFallback: attachmentReviewedFallback,
      inlineMarkup: false,
    };
  }
  const remaining = budget - focus.length - markupUsed;
  const body = await readDocumentText(remaining, {
    markup,
    markupBudget: forMarkup,
  });

  if (markup) {
    resolveMarkupLocations(comments, changes);
    if (attachmentUsesInlineMarkup) {
      changes.items = lastInlineChanges;
      changes.truncated = lastInlineChangesTruncated;
      comments.items = comments.items
        .filter((note) => note.replies.length > 0 || note.resolved)
        .concat(lastInlineAppendixComments);
    }
  }

  return {
    scope,
    document: body.text,
    paragraphs: body.paragraphs,
    // A selection that fills the budget leaves no room for the body at all.
    truncated: body.truncated || focusCut || remaining <= 0,
    focus,
    markup,
    comments,
    changes,
    listMarks: body.listMarks || selected.listMarks,
    reviewedFallback: attachmentReviewedFallback,
    inlineMarkup: attachmentUsesInlineMarkup,
    inlineCommentCount: attachmentUsesInlineMarkup ? lastInlineCommentCount : undefined,
    shapes: body.shapes,
  };
}

export async function getSelectionText(): Promise<string> {
  return Word.run(async (context) => {
    const range = context.document.getSelection();
    range.load("text");
    await context.sync();
    return range.text || "";
  });
}

/**
 * Selection text the model sees. List marks are added here, not in
 * `getSelectionText`, which the pane uses to tell an empty caret from a range.
 */
async function readSelectionAttachment(): Promise<{
  text: string;
  listMarks: boolean;
  paragraphs: number;
}> {
  if (!isWordHost()) {
    return { text: "", listMarks: false, paragraphs: 0 };
  }
  try {
    return await Word.run(async (context) => {
      const range = context.document.getSelection();
      range.load("text");
      const collection = range.paragraphs;
      collection.load("items/text,items/isListItem");
      await context.sync();
      const raw = range.text || "";
      const paragraphs = raw.split(/\r\n?|\n/).filter((line) => line.trim()).length;
      if (!raw.trim()) {
        return { text: raw, listMarks: false, paragraphs };
      }
      await loadListStrings(context, collection.items);

      const useReviewed = canReadReviewed();
      type ReviewedTextResult = { value: string };
      const reviewed: ReviewedTextResult[] = [];
      if (useReviewed) {
        for (const paragraph of collection.items) {
          reviewed.push(
            paragraph.getReviewedText(Word.ChangeTrackingVersion.current) as ReviewedTextResult
          );
        }
        try {
          await context.sync();
        } catch {
          attachmentReviewedFallback = true;
          reviewed.length = 0;
        }
      } else {
        attachmentReviewedFallback = true;
      }

      const lines: string[] = [];
      let listMarks = false;
      for (let index = 0; index < collection.items.length; index += 1) {
        const paragraph = collection.items[index];
        const line =
          !attachmentReviewedFallback && reviewed[index]
            ? paragraphText({ text: reviewed[index].value || "" })
            : paragraphText(paragraph);
        if (!line.trim()) {
          continue;
        }
        const mark = listMarkOf(paragraph);
        if (mark.isListItem) {
          listMarks = true;
        }
        lines.push(formatSelectionLine(line, mark));
      }
      return {
        text: lines.length ? lines.join("\r") : raw,
        listMarks,
        paragraphs: lines.length || paragraphs,
      };
    });
  } catch {
    const raw = await getSelectionText().catch(() => "");
    return {
      text: raw,
      listMarks: false,
      paragraphs: raw.split(/\r\n?|\n/).filter((line) => line.trim()).length,
    };
  }
}

export async function getSelectionInfo(): Promise<{ text: string; paragraphs: number }> {
  const read = await readSelectionAttachment();
  return { text: read.text, paragraphs: read.paragraphs };
}

/**
 * Every model-driven edit is tracked, so the user can review or reject any of
 * it from Word itself. Formatting changes are recorded too.
 */
function startTracking(context: Word.RequestContext): void {
  context.document.changeTrackingMode = Word.ChangeTrackingMode.trackAll;
}

function quoteBlockedByDeletion(where: string): Error {
  return new Error(
    `${where}には削除中の文字が挟まっているため、引用で絞り込めません。` +
      `quote を省いて段落全体を対象にするか、Word の校閲タブで削除を確定してください。`
  );
}

async function paragraphHasDeletionChanges(
  context: Word.RequestContext,
  paragraph: Word.Paragraph
): Promise<boolean> {
  if (!canReadChanges()) {
    return false;
  }
  try {
    const list = paragraph.getTrackedChanges();
    list.load("items/type");
    await context.sync();
    return list.items.some((change) => String(change.type || "") === "Deleted");
  } catch {
    return false;
  }
}

function assertSearchable(quote: string): void {
  if (quote.length > MAX_SEARCH_CHARS) {
    throw new Error(
      `引用が ${MAX_SEARCH_CHARS} 字を超えています。Word の検索の上限です。` +
        `paragraph で段落を指すか、その段落の中の一続きだけを引用してください。` +
        `引用を縮めるときも、本文どおりに写した一続きにしてください。`
    );
  }
  if (/[\r\n]/.test(quote)) {
    throw new Error(
      "引用が段落をまたいでいます。paragraph で段落を指すか、1 段落（添付本文の 1 行）に収まる引用にしてください。"
    );
  }
}

/**
 * A quote that matches more than once is refused instead of edited. Picking the
 * first hit silently rewrites the wrong clause, which the user cannot see.
 * The advice has to fit `assertSearchable`: longer, but one paragraph and 255
 * characters at most.
 */
function ambiguousQuote(needle: string, count: number, where: string): Error {
  return new Error(
    `「${needle}」が${where}に ${count} 箇所あります。paragraph で段落を指すか、` +
      `同じ段落の中で前後を足して 1 か所だけに当たる ${MAX_SEARCH_CHARS} 字までの引用にしてください。`
  );
}

/** The label belongs to the attachment, not to the document. */
function stripParagraphLabel(quote: string): string {
  return quote.replace(PARAGRAPH_LABEL, "").trim();
}

function quoteNeedle(raw: string, paragraph?: number): string {
  let needle = stripParagraphLabel(raw);
  const listString =
    paragraph === undefined ? undefined : attachedParagraphs.get(paragraph)?.listString;
  needle = stripListMarks(needle, listString);
  needle = stripInlineMarkup(needle);
  return needle;
}

/**
 * The replacement keeps the model's spaces. Quote search folds whitespace so a
 * missing ideographic space still matches; doing that here would record those
 * spaces as revisions the model did not make.
 */
function replacementBody(text: string, paragraph?: number): string {
  const listString =
    paragraph === undefined ? undefined : attachedParagraphs.get(paragraph)?.listString;
  return stripListMarks(stripParagraphLabel(text), listString).replace(/〔[+-\u6ce8][^〕]*〕/g, "");
}

const MAX_CANDIDATES = 3;
const CANDIDATE_CHARS = 120;
/** Below this, a shared pair or two is coincidence rather than a near miss. */
const CANDIDATE_SCORE = 0.2;

function compact(text: string): string {
  return text.replace(/[\s\u3000]/g, "");
}

function bigrams(text: string): Set<string> {
  const dense = compact(text);
  const out = new Set<string>();
  for (let i = 0; i + 1 < dense.length; i += 1) {
    out.add(dense.slice(i, i + 2));
  }
  if (!out.size && dense) {
    out.add(dense);
  }
  return out;
}

/**
 * How alike two strings are, by the character pairs they share. Cheap enough to
 * run over every paragraph of a long contract, which a longest-common-substring
 * score is not.
 */
function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) {
    return 0;
  }
  let shared = 0;
  for (const gram of a) {
    if (b.has(gram)) {
      shared += 1;
    }
  }
  return (2 * shared) / (a.size + b.size);
}

/**
 * The attached paragraphs that look most like a quote that did not match. Read
 * from the attachment rather than the document because that is what the model
 * was quoting from, and because a failed call should not cost another full read.
 */
function nearestParagraphs(needle: string): string[] {
  const wanted = bigrams(needle);
  return [...attachedParagraphs.entries()]
    .map(([number, row]) => ({
      number,
      row,
      score: dice(wanted, bigrams(row.text)),
    }))
    .filter((entry) => entry.score >= CANDIDATE_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES)
    .map((entry) =>
      formatAttachedLine(entry.number, clipNote(entry.row.shown, CANDIDATE_CHARS), {
        isListItem: entry.row.isListItem,
        listString: entry.row.listString,
      })
    );
}

/**
 * The quote missed. Length is almost never the reason, so the message does not
 * say "shorter": it says the quote must be copied as it stands, and hands over
 * the paragraphs that come closest so the next call can use a number.
 */
function quoteNotFound(needle: string, where: string): Error {
  const candidates = nearestParagraphs(needle);
  const advice = candidates.length
    ? `近い段落は次のものです。paragraph にその番号を渡すのが確実です。\n${candidates.join("\n")}`
    : "似た段落もありません。その文言は文書に無いので、あるものとして扱わず、無いことを利用者に伝えてください。";
  return new Error(
    `「${needle}」は${where}にありません。引用は添付された本文から字句どおりに写してください` +
      `（要約・言い換え・助詞の違いは当たりません）。${advice}`
  );
}

type QuoteSearchOptions = { matchCase: boolean; matchWholeWord: boolean; ignoreSpace?: boolean };

/**
 * Exact match first, then again ignoring white space. A clause label carries a
 * full-width space before its heading, which the model does not reproduce when
 * it quotes its own draft back to us: it sends 「第12条（協議）」 for a document
 * that holds a full-width space after 条. Without this the model burns a round
 * trip per clause guessing where the space goes.
 */
async function findQuote(
  context: Word.RequestContext,
  search: (options: QuoteSearchOptions) => Word.RangeCollection
): Promise<Word.Range[]> {
  const exact = search({ matchCase: false, matchWholeWord: false });
  exact.load("items");
  await context.sync();
  if (exact.items.length) {
    return exact.items;
  }
  const loose = search({ matchCase: false, matchWholeWord: false, ignoreSpace: true });
  loose.load("items");
  await context.sync();
  return loose.items;
}

/** What an operation says it applies to. */
export type TargetRef = { paragraph?: number; quote?: string };

/**
 * `paragraph` widens to the whole paragraph when the narrowing quote misses,
 * `refuse` stops instead. A comment on the whole paragraph is still the comment
 * the user asked for; a replacement on the whole paragraph is not.
 */
type MissMode = "paragraph" | "refuse";

/** The resolved range plus what to tell the model about where it landed. */
type Target = { range: Word.Range; note: string };

type PagedRange = Word.Range & {
  pages?: { load: (propertyNames: string) => void; items: Array<{ index?: number }> };
};

/**
 * First layout page of a hit, counted from the start of the document.
 * A footer that restarts at 1 is a different number; if Word cannot say, say nothing.
 */
async function layoutPageSentence(context: Word.RequestContext, range: Word.Range): Promise<string> {
  if (!canReadLayoutPage()) {
    return "";
  }
  try {
    const pages = (range as PagedRange).pages;
    if (!pages) {
      return "";
    }
    pages.load("items/index");
    await context.sync();
    const index = pages.items[0]?.index;
    if (typeof index !== "number" || !Number.isFinite(index) || index < 1) {
      return "";
    }
    return `文書の${index}ページ目です。`;
  } catch {
    return "";
  }
}

function withLayoutPage(note: string, page: string): string {
  return page ? `${note}${page}` : note;
}

/**
 * The paragraph a number points at. The number describes the document as it was
 * when the attachment was read, so the remembered text is used to find it again:
 * an insert made earlier in this same turn would otherwise shift the target down
 * by however many paragraphs were added.
 */
function locateParagraph(
  items: Word.Paragraph[],
  number: number
): { paragraph: Word.Paragraph; text: string; index: number } {
  if (!items.length) {
    throw new Error("本文に段落がありません。");
  }

  const texts = items.map((item) => paragraphText(item));
  const wanted = attachedParagraphs.get(number);
  if (wanted) {
    const dense = texts.map(compact);
    const target = compact(wanted.text);
    const from = Math.min(Math.max(number - 1, 0), items.length - 1);
    for (let step = 0; step < items.length; step += 1) {
      const after = from + step;
      if (after < items.length && dense[after] === target) {
        return { paragraph: items[after], text: texts[after], index: after };
      }
      const before = from - step;
      if (before >= 0 && dense[before] === target) {
        return { paragraph: items[before], text: texts[before], index: before };
      }
    }
  }

  if (attachedParagraphCount && items.length !== attachedParagraphCount) {
    throw new Error(
      `段落 ${number} が、添付したときと同じ文言で見つかりません。このターンで段落の数が変わったため、` +
        `番号だけでは位置を特定できません。quote に本文どおりの引用を渡して指し直すか、` +
        `どこを直すつもりだったかを利用者に伝えてください。`
    );
  }
  const index = number - 1;
  if (index < 0 || index >= items.length) {
    throw new Error(
      `段落 ${number} はありません。番号は添付された本文の行頭の [番号] から取り、` +
        `1〜${items.length} の範囲で指してください。`
    );
  }
  return { paragraph: items[index], text: texts[index], index };
}

async function paragraphByNumber(
  context: Word.RequestContext,
  number: number
): Promise<{ paragraph: Word.Paragraph; text: string }> {
  const paragraphs = context.document.body.paragraphs;
  paragraphs.load("items/text");
  await context.sync();
  const found = locateParagraph(paragraphs.items, number);
  return { paragraph: found.paragraph, text: found.text };
}

/**
 * Resolve what an operation applies to. A paragraph number wins, because it is
 * the one address the model can copy without retyping the document; a quote then
 * narrows inside that paragraph. With no number, the quote is looked for inside
 * the selection first so a repeated phrase elsewhere is not hit by accident.
 */
async function resolveTarget(
  context: Word.RequestContext,
  ref: TargetRef,
  onMiss: MissMode = "refuse"
): Promise<Target> {
  const raw = (ref.quote || "").trim();
  const labelOnly = raw.match(PARAGRAPH_LABEL_ONLY);
  const number = ref.paragraph ?? (labelOnly ? Number(labelOnly[1]) : undefined);
  // Models paste the label and the list mark back with the line they copied.
  const needle = quoteNeedle(raw, number);

  if (number !== undefined) {
    const found = await paragraphByNumber(context, number);
    const where = `段落 ${number}「${clipNote(found.text, 24)}」`;
    if (!needle) {
      const range = found.paragraph.getRange();
      const page = await layoutPageSentence(context, range);
      return { range, note: withLayoutPage(`${where}を対象にしました。`, page) };
    }
    assertSearchable(needle);
    const hits = await findQuote(context, (options) => found.paragraph.search(needle, options));
    if (hits.length === 1) {
      const page = await layoutPageSentence(context, hits[0]);
      return {
        range: hits[0],
        note: withLayoutPage(`${where}の「${clipNote(needle, 20)}」を対象にしました。`, page),
      };
    }
    if (onMiss === "paragraph") {
      const why = hits.length
        ? `引用が段落の中に ${hits.length} 箇所あった`
        : "引用が段落の中に無かった";
      const range = found.paragraph.getRange();
      const page = await layoutPageSentence(context, range);
      return { range, note: withLayoutPage(`${why}ので、${where}の全体にしました。`, page) };
    }
    if (hits.length > 1) {
      throw new Error(
        `「${needle}」は${where}の中に ${hits.length} 箇所あります。` +
          `前後を足して 1 か所に絞るか、quote を省いて段落全体を対象にしてください。`
      );
    }
    if (hits.length === 0 && (await paragraphHasDeletionChanges(context, found.paragraph))) {
      throw quoteBlockedByDeletion(where);
    }
    throw new Error(
      `「${needle}」は${where}の中にありません。この段落の文言は「${clipNote(found.text, 80)}」です。` +
        `字句どおりに写すか、quote を省いて段落全体を対象にしてください。`
    );
  }

  const selection = context.document.getSelection();
  selection.load("text");
  await context.sync();

  if (!needle) {
    // Without a selection an empty range would edit nothing and report success.
    if (!(selection.text || "").trim()) {
      throw new Error(
        "対象が指定されていません。paragraph に添付本文の段落番号を渡すか、quote に本文どおりの引用を入れてください。"
      );
    }
    return { range: selection, note: "" };
  }
  assertSearchable(needle);

  if ((selection.text || "").trim()) {
    const inSelection = await findQuote(context, (options) => selection.search(needle, options));
    if (inSelection.length > 1) {
      throw ambiguousQuote(needle, inSelection.length, "選択範囲");
    }
    if (inSelection.length === 1) {
      return { range: inSelection[0], note: "" };
    }
  }

  const body = context.document.body;
  const inBody = await findQuote(context, (options) => body.search(needle, options));
  if (inBody.length > 1) {
    throw ambiguousQuote(needle, inBody.length, "本文");
  }
  if (inBody.length === 1) {
    return { range: inBody[0], note: "" };
  }

  throw quoteNotFound(needle, "本文");
}

/**
 * Returns where the comment landed. A comment that ended up on a different
 * paragraph than intended is invisible in a success message, and the user finds
 * it later in the margin of the wrong clause.
 */
export async function insertComment(args: InsertCommentArgs): Promise<string> {
  return Word.run(async (context) => {
    const target = await resolveTarget(context, args, "paragraph");
    target.range.insertComment(truncateComment(formatComment(args.comment, args.severity)));
    await context.sync();
    return target.note;
  });
}

export async function replaceSelection(text: string): Promise<string> {
  return Word.run(async (context) => {
    startTracking(context);
    const selection = context.document.getSelection();
    selection.load("text");
    await context.sync();
    if (!(selection.text || "").trim()) {
      throw new Error("選択範囲が空です。置き換える範囲を選んでから指示してください。");
    }
    const outcome = await applyRedline(context, selection, text);
    return redlineNote("", outcome);
  });
}

export async function replaceQuote(args: ReplaceQuoteArgs): Promise<string> {
  return Word.run(async (context) => {
    startTracking(context);
    const target = await resolveTarget(context, args);
    const outcome = await applyRedline(context, target.range, replacementBody(args.text, args.paragraph));
    return redlineNote(target.note, outcome);
  });
}

type RedlineOutcome = "same" | "narrow" | "whole" | "span";

function redlineNote(note: string, outcome: RedlineOutcome): string {
  if (outcome === "same") {
    return `${note}文言は同じだったので、変更履歴は残していません。`;
  }
  if (outcome === "narrow") {
    return `${note}変更履歴には違った部分だけを残しました。`;
  }
  if (outcome === "span") {
    return `${note}段落をまたぐので、範囲全体を変更履歴にしました。`;
  }
  return note;
}

/**
 * `?` with wildcards is one range per character, in order, and the paragraph
 * mark is the last `\r`. A surrogate pair comes back as one range. Markup All
 * keeps tracked deletions in that list, so a later op can see when it would
 * cover one. Measured on desktop Word, 2000 characters took under a second.
 */
async function applyRedline(
  context: Word.RequestContext,
  range: Word.Range,
  after: string
): Promise<RedlineOutcome> {
  if (/[\r\n]/.test(after)) {
    throw new Error("置換後の文が段落をまたいでいます。段落の分割は insert_blocks を使ってください。");
  }
  const paragraphs = range.paragraphs;
  if (paragraphs) {
    paragraphs.load("items");
    await context.sync();
  }
  if (paragraphs && paragraphs.items.length > 1) {
    range.insertText(after, Word.InsertLocation.replace);
    await context.sync();
    return "span";
  }

  let filter: Word.RevisionsFilter | null = null;
  let previousMarkup: Word.RevisionsFilter["markup"] | null = null;
  let previousView: Word.RevisionsFilter["view"] | null = null;
  try {
    filter = context.document.activeWindow.view.revisionsFilter;
    filter.load("markup,view");
    await context.sync();
    previousMarkup = filter.markup;
    previousView = filter.view;
    filter.markup = "All";
    filter.view = "Final";
    await context.sync();
  } catch {
    filter = null;
  }
  try {
    const hits = range.search("?", { matchWildcards: true, matchCase: true });
    hits.load("items/text");
    const reviewed = range.getReviewedText(Word.ChangeTrackingVersion.current);
    await context.sync();
    const cells: Word.Range[] = [];
    const tokens: string[] = [];
    for (const cell of hits.items) {
      const raw = cell.text || "";
      if (raw === "\r" || raw === "\u0007") {
        continue;
      }
      cells.push(cell);
      tokens.push(raw === "\u000b" ? " " : raw);
    }
    // getReviewedText returns a ClientResult filled by the sync above.
    // eslint-disable-next-line office-addins/load-object-before-read
    const shown = paragraphText({ text: reviewed.value || "" });
    const aligned = reviewedCells(tokens, cells, shown);
    const ops = planRedline(aligned.tokens, Array.from(after));
    if (!ops.length) {
      return "same";
    }
    const alignment = aligned.alignment;
    if (alignment && ops.some((op) => opHitsDeletion(op, alignment, tokens.length))) {
      throw new Error(
        "この変更は、範囲にある既存の変更履歴に重なります。" +
          "校閲でこの範囲の履歴を確定してからやり直してください。"
      );
    }
    const whole =
      ops.length === 1 && ops[0].start === 0 && ops[0].end === aligned.tokens.length && ops[0].text.length > 0;
    for (let i = ops.length - 1; i >= 0; i -= 1) {
      writeOp(aligned.cells, range, ops[i]);
      await context.sync();
    }
    return whole || !tokens.length ? "whole" : "narrow";
  } finally {
    if (filter && previousMarkup !== null && previousView !== null) {
      filter.markup = previousMarkup;
      filter.view = previousView;
      try {
        await context.sync();
      } catch {
        // The view restore is best-effort. The edit itself already synced.
      }
    }
  }
}

function reviewedCells(
  tokens: string[],
  cells: Word.Range[],
  shown: string
): { tokens: string[]; cells: Word.Range[]; alignment: ReviewedAlignment | null } {
  if (tokens.join("") === shown) {
    return { tokens, cells, alignment: null };
  }
  const alignment = alignReviewed(tokens, shown);
  if (!alignment) {
    throw new Error(
      "この範囲の表示と、変更を承認したあとの文面が一致しないため、差分だけを履歴に残せません。" +
        "校閲でこの範囲の履歴を確定してからやり直してください。"
    );
  }
  return {
    tokens: Array.from(shown),
    cells: alignment.rawIndex.map((index) => cells[index < 0 ? 0 : index]),
    alignment,
  };
}

function writeOp(cells: Word.Range[], range: Word.Range, op: RedlineOp): void {
  if (op.start === op.end) {
    const point =
      cells.length === 0
        ? range.getRange(Word.RangeLocation.start)
        : op.start >= cells.length
          ? cells[cells.length - 1].getRange(Word.RangeLocation.end)
          : cells[op.start].getRange(Word.RangeLocation.start);
    point.insertText(op.text, op.start >= cells.length ? Word.InsertLocation.after : Word.InsertLocation.before);
    return;
  }
  const span =
    op.end - op.start === 1 ? cells[op.start] : cells[op.start].expandTo(cells[op.end - 1]);
  if (!op.text) {
    span.delete();
    return;
  }
  span.insertText(op.text, Word.InsertLocation.replace);
}

function alignmentOf(spec: ParagraphSpec): Word.Alignment {
  if (spec.alignment === "center") {
    return Word.Alignment.centered;
  }
  if (spec.alignment === "right") {
    return Word.Alignment.right;
  }
  return Word.Alignment.left;
}

function paintSpecs(specs: ParagraphSpec[], resolved: ResolvedInsert): ParagraphSpec[] {
  return specs.map((spec) => paintParagraph(spec, spec.type === "title" ? resolved.title : resolved.body));
}

function faceReading(paragraph: Word.Paragraph): FaceReading {
  const size = paragraph.font.size;
  return {
    text: paragraph.text || "",
    name: paragraph.font.name || "",
    nameFarEast: paragraph.font.nameFarEast || "",
    sizePt: typeof size === "number" && size > 0 ? size : 0,
    centered: paragraph.alignment === Word.Alignment.centered,
    heading: isBuiltinHeadingStyle(String(paragraph.styleBuiltIn || "")),
    inTable: (paragraph.tableNestingLevel || 0) > 0,
  };
}

async function stepParagraphs(
  context: Word.RequestContext,
  start: Word.Paragraph,
  direction: "previous" | "next"
): Promise<Word.Paragraph[]> {
  const found: Word.Paragraph[] = [];
  let current = start;
  for (let i = 0; i < SAMPLE_RADIUS; i += 1) {
    const next =
      direction === "previous" ? current.getPreviousOrNullObject() : current.getNextOrNullObject();
    await context.sync();
    if (next.isNullObject) {
      break;
    }
    found.push(next);
    current = next;
  }
  return found;
}

async function loadFaces(
  context: Word.RequestContext,
  paragraphs: Word.Paragraph[]
): Promise<FaceReading[]> {
  for (const paragraph of paragraphs) {
    paragraph.load("text,styleBuiltIn,alignment,tableNestingLevel");
    paragraph.font.load("name,nameFarEast,size");
  }
  await context.sync();
  return paragraphs.map((paragraph) => faceReading(paragraph));
}

async function spacingOf(
  context: Word.RequestContext,
  paragraph: Word.Paragraph
): Promise<SampledParagraph["spacing"]> {
  const ooxml = paragraph.getOoxml();
  await context.sync();
  const reading = readParagraphLineSpacing(ooxml.value || "");
  if (reading.snapOff && (reading.line !== null || reading.lineRule !== null)) {
    return { kind: "copy", line: reading.line, lineRule: reading.lineRule };
  }
  return { kind: "keep" };
}

async function resolveAtAnchor(
  context: Word.RequestContext,
  anchor: Word.Paragraph,
  format: InsertFormatContext
): Promise<ResolvedInsert> {
  if (!format.hasBody) {
    return resolveInsertFormats(format.user, [], 0, format.settings, false);
  }
  const backward = await stepParagraphs(context, anchor, "previous");
  const towardStart = [...backward].reverse();
  let paragraphs = [...towardStart, anchor];
  let faces = await loadFaces(context, paragraphs);
  const anchorIndex = towardStart.length;
  if (nearestBodyIndex(faces, anchorIndex) === null) {
    const forward = await stepParagraphs(context, anchor, "next");
    if (forward.length) {
      paragraphs = [...paragraphs, ...forward];
      faces = await loadFaces(context, paragraphs);
    }
  }
  const samples: SampledParagraph[] = faces.map((face) => ({ ...face, spacing: { kind: "keep" } }));
  const chosen = new Map<number, SampledParagraph["spacing"]>();
  const indexes = new Set<number>();
  if (!format.user.lineSpacingChars) {
    const bodyAt = nearestBodyIndex(faces, anchorIndex);
    const titleAt = nearestTitleIndex(faces, anchorIndex, bodyAt === null ? null : faces[bodyAt].sizePt);
    if (bodyAt !== null) {
      indexes.add(bodyAt);
    }
    if (titleAt !== null) {
      indexes.add(titleAt);
    }
  }
  for (const index of indexes) {
    chosen.set(index, await spacingOf(context, paragraphs[index]));
  }
  const withSpacing = samples.map((sample, index) =>
    chosen.has(index) ? { ...sample, spacing: chosen.get(index)! } : sample
  );
  return resolveInsertFormats(format.user, withSpacing, anchorIndex, format.settings, true);
}

function nearestBodyIndex(faces: FaceReading[], anchorIndex: number): number | null {
  return nearestFace(faces, anchorIndex, (face) => {
    return (
      Boolean(face.text.trim()) &&
      face.sizePt > 0 &&
      Boolean(face.name.trim() || face.nameFarEast.trim()) &&
      !face.heading &&
      !face.centered &&
      !face.inTable
    );
  });
}

function nearestTitleIndex(faces: FaceReading[], anchorIndex: number, bodySize: number | null): number | null {
  return nearestFace(faces, anchorIndex, (face) => {
    if (!face.text.trim() || face.inTable || face.sizePt <= 0 || !(face.name.trim() || face.nameFarEast.trim())) {
      return false;
    }
    if (face.centered) {
      return true;
    }
    return bodySize !== null && face.sizePt > bodySize;
  });
}

function nearestFace(
  faces: FaceReading[],
  anchorIndex: number,
  accept: (face: FaceReading) => boolean
): number | null {
  let best: { index: number; distance: number } | null = null;
  for (let index = 0; index < faces.length; index += 1) {
    if (!accept(faces[index])) {
      continue;
    }
    const distance = Math.abs(index - anchorIndex);
    const before = index <= anchorIndex;
    if (!best || distance < best.distance || (distance === best.distance && before && best.index > anchorIndex)) {
      best = { index, distance };
    }
  }
  return best ? best.index : null;
}

function styleParagraph(paragraph: Word.Paragraph, spec: ParagraphSpec): void {
  paragraph.alignment = alignmentOf(spec);
  if (spec.applyFont !== false) {
    paragraph.font.name = spec.fontName;
    paragraph.font.nameFarEast = spec.fontNameFarEast || spec.fontName;
  }
  if (spec.applySize !== false) {
    paragraph.font.size = spec.fontSize;
  }
  paragraph.font.bold = spec.bold;
  if (spec.applyIndent !== false) {
    paragraph.firstLineIndent = spec.firstLineIndentPt;
    paragraph.leftIndent = spec.leftIndentPt;
  }
  if ((spec.spacingKind ?? "exact") === "exact" && spec.lineSpacingPt > 0) {
    paragraph.lineSpacing = spec.lineSpacingPt;
  }
}

function wantsExactSpacing(spec: ParagraphSpec): boolean {
  return (spec.spacingKind ?? "exact") === "exact" && spec.lineSpacingPt > 0;
}

/**
 * The paragraph the new text goes after. A quote wins over `at` because it is
 * the only way to say "after this clause". `continue` reads the bookmark left by
 * the previous insert, so a split draft keeps going even across turns or after
 * the user clicks elsewhere, and falls back to the cursor when nothing has been
 * drafted into this document yet.
 */
async function resolveInsertStart(
  context: Word.RequestContext,
  at: InsertAtArg,
  quote: string,
  paragraph?: number
): Promise<{ paragraph: Word.Paragraph; placement: InsertPlacement }> {
  if (paragraph !== undefined) {
    const found = await paragraphByNumber(context, paragraph);
    return { paragraph: found.paragraph, placement: "paragraph" };
  }
  if (quote.trim()) {
    const target = await resolveTarget(context, { quote });
    return { paragraph: target.range.paragraphs.getFirst(), placement: "quote" };
  }
  if (at === "end") {
    return { paragraph: context.document.body.paragraphs.getLast(), placement: "end" };
  }
  if (at === "continue") {
    const anchor = context.document.getBookmarkRangeOrNullObject(DRAFT_TAIL_BOOKMARK);
    await context.sync();
    if (!anchor.isNullObject) {
      return { paragraph: anchor.paragraphs.getLast(), placement: "continue" };
    }
  }
  return {
    paragraph: context.document.getSelection().paragraphs.getLast(),
    placement: "cursor",
  };
}

/**
 * Insert structured paragraphs and mark the tail so the next chunk can continue
 * from it. Returns what the text landed after, which is how the model finds out
 * that `continue` had no anchor or that its quote pointed at the wrong clause.
 */
export type InsertFormatContext = {
  hasBody: boolean;
  user: UserFormat;
  settings: SettingsFormat;
};

export async function insertDraftParagraphs(
  specs: ParagraphSpec[],
  at: InsertAtArg = "cursor",
  quote = "",
  paragraph?: number,
  format?: InsertFormatContext
): Promise<InsertLanding> {
  const asked: InsertPlacement =
    paragraph !== undefined ? "paragraph" : quote.trim() ? "quote" : at;
  if (!specs.length) {
    return { placement: asked, after: "" };
  }

  let landing: InsertLanding = { placement: asked, after: "" };
  await Word.run(async (context) => {
    startTracking(context);
    const resolved = await resolveInsertStart(context, at, quote, paragraph);
    resolved.paragraph.load("text");
    await context.sync();
    landing = { placement: resolved.placement, after: resolved.paragraph.text || "" };
    const painted = format
      ? paintSpecs(specs, await resolveAtAnchor(context, resolved.paragraph, format))
      : specs;
    let current: Word.Paragraph = resolved.paragraph;
    const created: { paragraph: Word.Paragraph; spec: ParagraphSpec }[] = [];

    for (const spec of painted) {
      const text = specPlainText(spec) || "";
      const paragraph = current.insertParagraph(text, Word.InsertLocation.after);
      styleParagraph(paragraph, spec);
      created.push({ paragraph, spec });
      current = paragraph;
    }

    await context.sync();

    const exact = created.filter((entry) => wantsExactSpacing(entry.spec));
    if (exact.length) {
      await rewriteParagraphOoxml(
        context,
        exact.map((entry) => entry.paragraph),
        { unsetLineGrid: true }
      );
    }
    const copies = created.filter(
      (entry) => entry.spec.spacingKind === "copy" && entry.spec.spacingCopy
    );
    if (copies.length) {
      await rewriteCopiedLineSpacing(context, copies);
    }

    for (const { paragraph, spec } of created) {
      if (spec.type !== "item") {
        paragraph.load("isListItem");
      }
    }
    await context.sync();
    for (const { paragraph, spec } of created) {
      if (spec.type !== "item" && paragraph.isListItem) {
        paragraph.detachFromList();
      }
    }

    const boldHits: Word.RangeCollection[] = [];
    for (const { paragraph, spec } of created) {
      if (spec.bold || spec.runs.every((run) => run.bold)) {
        paragraph.font.bold = true;
        continue;
      }
      for (const run of spec.runs) {
        if (!run.bold || !run.text.trim()) {
          continue;
        }
        const found = paragraph.search(run.text, { matchCase: true, matchWholeWord: false });
        found.load("items");
        boldHits.push(found);
      }
    }
    if (boldHits.length) {
      await context.sync();
      for (const found of boldHits) {
        if (found.items[0]) {
          found.items[0].font.bold = true;
        }
      }
    }

    const last = created[created.length - 1].paragraph;
    last.getRange().insertBookmark(DRAFT_TAIL_BOOKMARK);
    last.select(Word.SelectionMode.end);
    await context.sync();

    try {
      const numbers = await numberInsertedParagraphs(
        context,
        created.map((entry) => entry.paragraph)
      );
      if (numbers.length) {
        landing = { ...landing, numbers };
      }
    } catch {
      // The insert stands; the model can still quote the new paragraphs.
    }
  });
  return landing;
}

type HandedParagraph = {
  number: number;
  paragraph: Word.Paragraph;
  index: number;
  text: string;
};

/**
 * A paragraph the model was shown. Numbers that were never handed out are
 * refused, because locateParagraph's index fallback would blank a neighbor.
 */
function findHandedParagraph(items: Word.Paragraph[], number: number): HandedParagraph {
  const wanted = attachedParagraphs.get(number);
  if (!wanted) {
    throw new Error(
      `段落 ${number} は今回の添付にありません。渡された [番号] だけを paragraphs に入れてください。空行は入れていません。`
    );
  }
  if (!items.length) {
    throw new Error("本文に段落がありません。空行は入れていません。");
  }
  const texts = items.map((item) => paragraphText(item));
  const dense = texts.map(compact);
  const target = compact(wanted.text);
  const from = Math.min(Math.max(number - 1, 0), items.length - 1);
  for (let step = 0; step < items.length; step += 1) {
    const after = from + step;
    if (after < items.length && dense[after] === target) {
      return { number, paragraph: items[after], text: texts[after], index: after };
    }
    const before = from - step;
    if (before >= 0 && dense[before] === target) {
      return { number, paragraph: items[before], text: texts[before], index: before };
    }
  }
  throw new Error(
    `段落 ${number} が、添付したときと同じ文言で見つかりません。空行は入れていません。`
  );
}

function previousIsBlank(items: Word.Paragraph[], index: number): boolean {
  if (index <= 0) {
    return false;
  }
  return !paragraphText(items[index - 1]).trim();
}

function styleBlankParagraph(paragraph: Word.Paragraph): void {
  // A copied heading style stays in the navigation pane. Outline level cannot override it.
  paragraph.styleBuiltIn = Word.BuiltInStyleName.normal;
  paragraph.firstLineIndent = 0;
  paragraph.leftIndent = 0;
  paragraph.spaceBefore = 0;
  paragraph.spaceAfter = 0;
  paragraph.lineUnitBefore = 0;
  paragraph.lineUnitAfter = 0;
}

function quotedHeads(rows: { text: string }[]): string {
  return rows.map((row) => `「${clipNote(row.text, 24)}」`).join("、");
}

function blankLineNote(inserted: { text: string }[], skipped: { text: string }[]): string {
  const parts: string[] = [];
  if (inserted.length) {
    parts.push(
      `${inserted.length} 箇所の直前に空行を入れました（${quotedHeads(inserted)}）。変更履歴に記録しました。`
    );
  } else {
    parts.push("空行は入れていません。");
  }
  if (skipped.length) {
    parts.push(`${skipped.length} 箇所は直前が空行だったので足していません（${quotedHeads(skipped)}）。`);
  }
  return parts.join("");
}

/**
 * One empty paragraph immediately before each addressed paragraph. An existing
 * blank immediately above is left as it is, including when several are already
 * there. The paragraphs below keep their list.
 */
export async function insertBlankBefore(paragraphs: number[]): Promise<string> {
  return Word.run(async (context) => {
    startTracking(context);
    const collection = context.document.body.paragraphs;
    collection.load("items/text");
    await context.sync();
    const items = collection.items;

    const addressed: HandedParagraph[] = [];
    const seen = new Set<number>();
    for (const number of paragraphs) {
      if (seen.has(number)) {
        continue;
      }
      seen.add(number);
      const found = findHandedParagraph(items, number);
      if (addressed.some((row) => row.index === found.index)) {
        throw new Error(
          `段落 ${number} は、別の番号と同じ段落を指しています。空行は入れていません。`
        );
      }
      addressed.push(found);
    }

    const skipped = addressed.filter((row) => previousIsBlank(items, row.index));
    const pending = addressed.filter((row) => !previousIsBlank(items, row.index));
    const created: Word.Paragraph[] = [];
    const descending = [...pending].sort((a, b) => b.index - a.index);
    for (const row of descending) {
      created.push(row.paragraph.insertParagraph("", Word.InsertLocation.before));
    }
    if (created.length) {
      for (const blank of created) {
        styleBlankParagraph(blank);
        blank.load("isListItem");
      }
      await context.sync();
      for (const blank of created) {
        if (isListed(blank)) {
          blank.detachFromList();
        }
      }
      await context.sync();
    }
    return blankLineNote(pending, skipped);
  });
}

/**
 * Hand out paragraph numbers for what an insert just created, so the same turn
 * can point at those paragraphs the way it points at attached ones. Without
 * this an empty document is numbered only from the next turn on, and the model
 * has to quote each new 項 and 号 — short items like 「数量　○○」 recur, and
 * `through` has nothing to count with.
 *
 * Numbers are body positions where nothing attached sits at or after the
 * insert (an empty document, or an insert at the end). Otherwise the attached
 * paragraphs below have moved down and their numbers are taken, so the new
 * ones continue past the highest number handed out; either way a number is
 * resolved through its text, never used as an index.
 */
async function numberInsertedParagraphs(
  context: Word.RequestContext,
  created: Word.Paragraph[]
): Promise<InsertedParagraph[]> {
  if (!created.length) {
    return [];
  }
  const collection = context.document.body.paragraphs;
  collection.load("items/text");
  for (const paragraph of created) {
    paragraph.load("text");
  }
  await context.sync();
  const items = collection.items;
  const dense = items.map((item) => compact(paragraphText(item)));
  const wanted = created.map((paragraph) => compact(paragraphText(paragraph)));

  const runs: number[] = [];
  for (let start = 0; start + wanted.length <= items.length; start += 1) {
    if (wanted.every((text, offset) => dense[start + offset] === text)) {
      runs.push(start);
    }
  }
  let start = runs[0];
  if (runs.length > 1) {
    // The same run of text more than once: ask Word which holds the new one.
    const first = created[0].getRange();
    const relations = runs.map((at) => items[at].getRange().compareLocationWith(first));
    await context.sync();
    const index = relations.findIndex(
      (relation) => relation.value === Word.LocationRelation.equal
    );
    start = index < 0 ? undefined : runs[index];
  }
  if (start === undefined) {
    return [];
  }

  const positional = start + 1;
  const taken = [...attachedParagraphs.keys()];
  const collides = taken.some((number) => number >= positional);
  const base = collides ? Math.max(attachedParagraphCount, ...taken) + 1 : positional;

  const numbers: InsertedParagraph[] = [];
  created.forEach((paragraph, offset) => {
    const raw = paragraphText(paragraph);
    const number = base + offset;
    if (!raw.trim()) {
      // Blank lines consume a number and cannot be pointed at, as in the attachment.
      return;
    }
    attachedParagraphs.set(number, {
      text: raw,
      shown: raw,
      listString: "",
      isListItem: false,
    });
    numbers.push({ number, text: raw });
  });
  if (!attachedParagraphCount) {
    // First numbers this turn: from here on a change in paragraph count is
    // something locateParagraph has to notice.
    attachedParagraphCount = items.length;
  }
  return numbers;
}

/**
 * Drop the draft anchor so a new conversation starts from the user's cursor
 * instead of wherever the previous draft ended. The bookmark lives in the file,
 * so leaving it behind would outlast the chat.
 */
export async function clearDraftAnchor(): Promise<void> {
  if (!isWordHost()) {
    return;
  }
  await Word.run(async (context) => {
    context.document.deleteBookmark(DRAFT_TAIL_BOOKMARK);
    await context.sync();
  });
}

function hasBulkAddress(args: { through?: number; paragraphs?: number[] }): boolean {
  return args.through !== undefined || Boolean(args.paragraphs && args.paragraphs.length);
}

async function loadBodyItems(context: Word.RequestContext): Promise<Word.Paragraph[]> {
  const collection = context.document.body.paragraphs;
  collection.load("items/text");
  await context.sync();
  return collection.items;
}

/**
 * Paragraphs a format call named by number. One load of the body, then either
 * the explicit list or the inclusive span `format_list` already uses.
 */
async function addressedParagraphs(
  context: Word.RequestContext,
  items: Word.Paragraph[],
  args: { paragraph?: number; through?: number; paragraphs?: number[]; quote?: string }
): Promise<Word.Paragraph[]> {
  if (args.paragraphs && args.paragraphs.length) {
    const seen = new Set<number>();
    const found: Word.Paragraph[] = [];
    for (const number of args.paragraphs) {
      const row = locateParagraph(items, number);
      if (seen.has(row.index)) {
        continue;
      }
      seen.add(row.index);
      found.push(row.paragraph);
    }
    if (!found.length) {
      throw new Error("対象の段落がありません。");
    }
    return found;
  }

  let start: Word.Paragraph;
  if (args.paragraph !== undefined) {
    start = locateParagraph(items, args.paragraph).paragraph;
  } else {
    const target = await resolveTarget(context, { quote: args.quote }, "paragraph");
    const ranged = target.range.paragraphs;
    ranged.load("items/text");
    await context.sync();
    const nonempty = ranged.items.filter((paragraph) => paragraphText(paragraph).trim());
    if (!nonempty.length) {
      throw new Error("対象の段落がありません。");
    }
    start = await anchorInBody(context, items, nonempty[0]);
  }
  if (args.through === undefined) {
    return [start];
  }
  const fromIndex = items.indexOf(start);
  if (fromIndex < 0) {
    throw new Error(
      "対象の段落を本文の中で特定できませんでした。paragraph に添付本文の段落番号を渡してください。"
    );
  }
  return spanListTargets(items, fromIndex, locateParagraph(items, args.through).index);
}

function paintFont(font: Word.Font, fields: TextFormatFields): void {
  if (fields.bold !== undefined) {
    font.bold = fields.bold;
  }
  if (fields.italic !== undefined) {
    font.italic = fields.italic;
  }
  if (fields.underline !== undefined) {
    font.underline = fields.underline ? Word.UnderlineType.single : Word.UnderlineType.none;
  }
  if (fields.size !== undefined) {
    font.size = fields.size;
  }
  if (fields.fontName !== undefined) {
    font.name = fields.fontName;
    font.nameFarEast = fields.fontName;
  }
  if (fields.color !== undefined) {
    font.color = fields.color;
  }
  if (fields.highlightColor !== undefined) {
    font.highlightColor = fields.highlightColor.trim() ? fields.highlightColor : null;
  }
}

function paintParagraphFields(paragraph: Word.Paragraph, fields: ParagraphFormatFields): void {
  if (fields.alignment !== undefined) {
    paragraph.alignment = wordAlignment(fields.alignment);
  }
  if (fields.firstLineIndent !== undefined) {
    paragraph.firstLineIndent = fields.firstLineIndent;
  }
  if (fields.leftIndent !== undefined) {
    paragraph.leftIndent = fields.leftIndent;
  }
  if (fields.spaceBefore !== undefined) {
    paragraph.spaceBefore = fields.spaceBefore;
    paragraph.lineUnitBefore = 0;
  }
  if (fields.spaceAfter !== undefined) {
    paragraph.spaceAfter = fields.spaceAfter;
    paragraph.lineUnitAfter = 0;
  }
  if (fields.lineSpacing !== undefined) {
    paragraph.lineSpacing = fields.lineSpacing;
  }
}

function withCountNote(note: string, extra: string): string {
  return extra ? `${note} ${extra}` : note;
}

async function applyParagraphFormat(
  context: Word.RequestContext,
  targets: Word.Paragraph[],
  fields: ParagraphFormatFields,
  note: string
): Promise<string> {
  const wantsIndent = fields.firstLineIndent !== undefined || fields.leftIndent !== undefined;
  for (const paragraph of targets) {
    paintParagraphFields(paragraph, fields);
    if (wantsIndent) {
      paragraph.font.load("size");
      paragraph.load("isListItem");
    }
  }
  await context.sync();
  const listed = wantsIndent && targets.some((paragraph) => isListed(paragraph));
  const ooxml = paragraphOoxmlOptions({ quote: "", ...fields });
  const extra = ooxml ? await rewriteParagraphOoxml(context, targets, ooxml) : "";
  const listNote = listed
    ? "番号の位置はリストが持っているので、段落のインデントでは番号は動きません。"
    : "";
  return withCountNote(note, [extra, listNote].filter(Boolean).join(" "));
}

export async function formatText(args: FormatTextArgs): Promise<string> {
  return Word.run(async (context) => {
    startTracking(context);
    if (hasBulkAddress(args)) {
      const items = await loadBodyItems(context);
      const targets = await addressedParagraphs(context, items, args);
      for (const paragraph of targets) {
        paintFont(paragraph.font, args);
      }
      await context.sync();
      return `対象は ${targets.length} 段落です。`;
    }
    const target = await resolveTarget(context, args);
    paintFont(target.range.font, args);
    await context.sync();
    return target.note;
  });
}

function wordAlignment(alignment: NonNullable<FormatParagraphArgs["alignment"]>): Word.Alignment {
  switch (alignment) {
    case "center":
      return Word.Alignment.centered;
    case "right":
      return Word.Alignment.right;
    case "justify":
      return Word.Alignment.justified;
    default:
      return Word.Alignment.left;
  }
}

export async function formatParagraph(args: FormatParagraphArgs): Promise<string> {
  return Word.run(async (context) => {
    startTracking(context);
    if (hasBulkAddress(args)) {
      const items = await loadBodyItems(context);
      const targets = await addressedParagraphs(context, items, args);
      return applyParagraphFormat(context, targets, args, `対象は ${targets.length} 段落です。`);
    }
    const target = await resolveTarget(context, args, "paragraph");
    const paragraphs = target.range.paragraphs;
    paragraphs.load("items");
    await context.sync();
    const wantsIndent = args.firstLineIndent !== undefined || args.leftIndent !== undefined;

    if (!paragraphs.items.length) {
      throw new Error("対象の段落が見つかりませんでした。");
    }

    for (const paragraph of paragraphs.items) {
      paintParagraphFields(paragraph, args);
      if (wantsIndent) {
        paragraph.font.load("size");
        paragraph.load("isListItem");
      }
    }
    await context.sync();
    const listed = wantsIndent && paragraphs.items.some((paragraph) => isListed(paragraph));
    const ooxml = paragraphOoxmlOptions(args);
    if (!ooxml) {
      return target.note;
    }
    const extra = await rewriteParagraphOoxml(context, paragraphs.items, ooxml);
    const listNote = listed
      ? "番号の位置はリストが持っているので、段落のインデントでは番号は動きません。"
      : "";
    const suffix = [extra, listNote].filter(Boolean).join(" ");
    return suffix ? `${target.note} ${suffix}` : target.note;
  });
}

function paragraphFact(paragraph: Word.Paragraph): ParagraphFact {
  let list: ParagraphFact["list"] = "none";
  if (isListed(paragraph)) {
    const mark = listMarkOf(paragraph);
    if (isBulletMark(mark)) {
      list = "bullet";
    } else if (isNumberMark(mark)) {
      list = "numbered";
    } else {
      list = "unknown";
    }
  }
  let outline: number | null = null;
  try {
    outline = readOutlineLevel(paragraph.outlineLevel);
  } catch {
    outline = null;
  }
  let inTable = false;
  try {
    inTable = (paragraph.tableNestingLevel || 0) > 0;
  } catch {
    inTable = false;
  }
  return {
    text: paragraphText(paragraph),
    style: readStyleName(paragraph),
    styleBuiltIn: readBuiltInStyle(paragraph),
    outlineLevel: outline,
    list,
    inTable,
  };
}

function readStyleName(paragraph: Word.Paragraph): string {
  try {
    return paragraph.style || "";
  } catch {
    return "";
  }
}

function readBuiltInStyle(paragraph: Word.Paragraph): string {
  try {
    return String(paragraph.styleBuiltIn || "");
  } catch {
    return "";
  }
}

const MATCH_LOAD =
  "items/text,items/style,items/styleBuiltIn,items/outlineLevel,items/isListItem,items/tableNestingLevel";

async function loadParagraphCollection(
  context: Word.RequestContext,
  properties: string
): Promise<Word.Paragraph[]> {
  const collection = context.document.body.paragraphs;
  collection.load(properties);
  await context.sync();
  return collection.items;
}

export async function applyFormat(args: ApplyFormatArgs): Promise<string> {
  return Word.run(async (context) => {
    startTracking(context);
    const items = await loadParagraphCollection(context, MATCH_LOAD);
    const listDetail = args.select.list === "bullet" || args.select.list === "numbered";
    if (listDetail) {
      await loadListMembership(context, items);
    }
    const facts = items.map((paragraph) => paragraphFact(paragraph));
    const match = compileParagraphMatcher(args.select);
    const targets = items.filter((_, index) => match(facts[index]));
    if (!targets.length) {
      return "条件に合う段落はありませんでした。";
    }
    for (const paragraph of targets) {
      paintFont(paragraph.font, args.format);
    }
    const note = `${targets.length} 段落に書式を当てました（変更履歴に書式変更として記録）。`;
    return applyParagraphFormat(context, targets, args.format, note);
  });
}

function replaceAllNote(count: number, skipped: number, args: ReplaceAllArgs): string {
  if (!count && !skipped) {
    return "一致する箇所はありませんでした。";
  }
  const changed = args.replace !== undefined;
  const formatted = Boolean(args.format);
  let note: string;
  if (!count) {
    note = "一致箇所はありましたが、置換できませんでした。";
  } else if (changed && formatted) {
    note = `${count} 件を置換し、書式を当てました（変更履歴に記録）。`;
  } else if (changed) {
    note = `${count} 件置換しました（変更履歴に記録）。`;
  } else {
    note = `${count} 件に書式を当てました（変更履歴に書式変更として記録）。`;
  }
  if (!skipped) {
    return note;
  }
  return `${note}${skipped} 件は長すぎるか位置を特定できず飛ばしました。`;
}

export async function replaceAll(args: ReplaceAllArgs): Promise<string> {
  return Word.run(async (context) => {
    startTracking(context);
    const items = await loadBodyItems(context);
    const query = {
      find: args.find,
      regex: args.regex,
      matchCase: args.matchCase,
      wholeWord: args.wholeWord,
    };
    type Pending = { paragraphIndex: number; match: TextMatch; search: Word.RangeCollection };
    const grouped: Pending[] = [];
    let planned = 0;
    let tooLong = 0;
    for (let index = 0; index < items.length; index += 1) {
      const matches = planTextMatches(paragraphText(items[index]), query);
      planned += matches.length;
      if (planned > MAX_REPLACE_MATCHES) {
        throw new Error(`一致が ${MAX_REPLACE_MATCHES} 件を超えています。検索を絞ってください。`);
      }
      const byNeedle = new Map<string, TextMatch[]>();
      for (const match of matches) {
        if ([...match.text].length > MAX_FIND_CHARS) {
          tooLong += 1;
          continue;
        }
        const list = byNeedle.get(match.text) || [];
        list.push(match);
        byNeedle.set(match.text, list);
      }
      for (const [needle, group] of byNeedle) {
        const search = items[index].search(needle, { matchCase: true, matchWholeWord: false });
        search.load("items");
        for (const match of group) {
          grouped.push({ paragraphIndex: index, match, search });
        }
      }
    }
    if (!grouped.length) {
      return replaceAllNote(0, tooLong, args);
    }
    await context.sync();

    type Write = { paragraphIndex: number; start: number; range: Word.Range };
    const writes: Write[] = [];
    for (const row of grouped) {
      const range = row.search.items[row.match.occurrence];
      if (!range) {
        continue;
      }
      writes.push({ paragraphIndex: row.paragraphIndex, start: row.match.start, range });
    }
    writes.sort((a, b) => b.paragraphIndex - a.paragraphIndex || b.start - a.start);
    for (const write of writes) {
      if (args.replace !== undefined) {
        const written = write.range.insertText(args.replace, Word.InsertLocation.replace);
        if (args.format) {
          paintFont(written.font, args.format);
        }
      } else if (args.format) {
        paintFont(write.range.font, args.format);
      }
    }
    if (writes.length) {
      await context.sync();
    }
    const skipped = tooLong + (grouped.length - writes.length);
    return replaceAllNote(writes.length, skipped, args);
  });
}

type CopiedCharacter = {
  bold?: boolean;
  italic?: boolean;
  underline?: string;
  size?: number;
  fontName?: string;
  color?: string;
  highlightColor?: string;
};

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readOptionalName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readCopiedCharacter(paragraph: Word.Paragraph): CopiedCharacter {
  const font = paragraph.font;
  let underline: string | undefined;
  try {
    const value = font.underline as unknown;
    if (typeof value === "string" && value && value !== "Mixed") {
      underline = value;
    }
  } catch {
    underline = undefined;
  }
  let highlight: string | undefined;
  try {
    const value = font.highlightColor;
    if (typeof value === "string" && value.trim()) {
      highlight = value;
    }
  } catch {
    highlight = undefined;
  }
  return {
    bold: readOptionalBoolean(font.bold),
    italic: readOptionalBoolean(font.italic),
    underline,
    size: readOptionalNumber(font.size),
    fontName: readOptionalName(font.name) || readOptionalName(font.nameFarEast),
    color: readOptionalName(font.color),
    highlightColor: highlight,
  };
}

function paintCopiedCharacter(font: Word.Font, copied: CopiedCharacter): boolean {
  let wrote = false;
  if (copied.bold !== undefined) {
    font.bold = copied.bold;
    wrote = true;
  }
  if (copied.italic !== undefined) {
    font.italic = copied.italic;
    wrote = true;
  }
  if (copied.underline) {
    font.underline = copied.underline as Word.UnderlineType;
    wrote = true;
  }
  if (copied.size !== undefined && copied.size > 0) {
    font.size = copied.size;
    wrote = true;
  }
  if (copied.fontName) {
    font.name = copied.fontName;
    font.nameFarEast = copied.fontName;
    wrote = true;
  }
  if (copied.color) {
    font.color = copied.color;
    wrote = true;
  }
  if (copied.highlightColor) {
    font.highlightColor = copied.highlightColor;
    wrote = true;
  }
  return wrote;
}

function alignmentArg(value: unknown): ParagraphFormatFields["alignment"] | undefined {
  const name = String(value ?? "");
  if (!name) {
    return undefined;
  }
  if (name === String(Word.Alignment.centered) || name === "Centered") {
    return "center";
  }
  if (name === String(Word.Alignment.right) || name === "Right") {
    return "right";
  }
  if (name === String(Word.Alignment.justified) || name === "Justified") {
    return "justify";
  }
  if (name === String(Word.Alignment.left) || name === "Left") {
    return "left";
  }
  return undefined;
}

function readCopiedParagraph(paragraph: Word.Paragraph): ParagraphFormatFields {
  const fields: ParagraphFormatFields = {};
  const alignment = alignmentArg(paragraph.alignment);
  if (alignment) {
    fields.alignment = alignment;
  }
  const first = readOptionalNumber(paragraph.firstLineIndent);
  if (first !== undefined) {
    fields.firstLineIndent = first;
  }
  const left = readOptionalNumber(paragraph.leftIndent);
  if (left !== undefined) {
    fields.leftIndent = left;
  }
  const before = readOptionalNumber(paragraph.spaceBefore);
  if (before !== undefined) {
    fields.spaceBefore = before;
  }
  const after = readOptionalNumber(paragraph.spaceAfter);
  if (after !== undefined) {
    fields.spaceAfter = after;
  }
  const spacing = readOptionalNumber(paragraph.lineSpacing);
  if (spacing !== undefined && spacing > 0) {
    fields.lineSpacing = spacing;
  }
  return fields;
}

async function resolveSample(
  context: Word.RequestContext,
  items: Word.Paragraph[],
  args: CopyFormatArgs
): Promise<Word.Paragraph> {
  if (args.from !== undefined) {
    return locateParagraph(items, args.from).paragraph;
  }
  const target = await resolveTarget(context, { quote: args.quote }, "paragraph");
  const ranged = target.range.paragraphs;
  ranged.load("items/text");
  await context.sync();
  const nonempty = ranged.items.filter((paragraph) => paragraphText(paragraph).trim());
  if (!nonempty.length) {
    throw new Error("見本の段落が見つかりませんでした。");
  }
  return anchorInBody(context, items, nonempty[0]);
}

export async function copyFormat(args: CopyFormatArgs): Promise<string> {
  return Word.run(async (context) => {
    startTracking(context);
    const copyCharacter = args.what !== "paragraph";
    const copyParagraph = args.what !== "character";
    const fontLoad = copyCharacter
      ? ",items/font/bold,items/font/italic,items/font/underline,items/font/size,items/font/name,items/font/nameFarEast,items/font/color,items/font/highlightColor"
      : "";
    const items = await loadParagraphCollection(
      context,
      MATCH_LOAD +
        ",items/alignment,items/firstLineIndent,items/leftIndent,items/spaceBefore,items/spaceAfter,items/lineUnitBefore,items/lineUnitAfter,items/lineSpacing" +
        fontLoad
    );

    const source = await resolveSample(context, items, args);
    let destinations: Word.Paragraph[];
    if (args.select && !args.paragraphs && args.paragraph === undefined && args.through === undefined) {
      const listDetail = args.select.list === "bullet" || args.select.list === "numbered";
      if (listDetail) {
        await loadListMembership(context, items);
      }
      const match = compileParagraphMatcher(args.select);
      destinations = items.filter((paragraph) => match(paragraphFact(paragraph)));
    } else {
      destinations = await addressedParagraphs(context, items, args);
    }
    const sourceIndex = items.indexOf(source);
    destinations = destinations.filter((paragraph) => items.indexOf(paragraph) !== sourceIndex);
    if (!destinations.length) {
      return "写す先がありません。見本の段落自身は対象にしません。";
    }

    const copiedFont = copyCharacter ? readCopiedCharacter(source) : null;
    const copiedParagraph = copyParagraph ? readCopiedParagraph(source) : null;
    const lineUnitBefore = copyParagraph ? readOptionalNumber(source.lineUnitBefore) : undefined;
    const lineUnitAfter = copyParagraph ? readOptionalNumber(source.lineUnitAfter) : undefined;
    let wroteCharacter = false;
    for (const paragraph of destinations) {
      if (copiedFont && paintCopiedCharacter(paragraph.font, copiedFont)) {
        wroteCharacter = true;
      }
    }
    if (copyCharacter && !wroteCharacter && !copyParagraph) {
      return "見本の文字書式が混在しているため、写せませんでした。";
    }

    let lineCopy: LineSpacingCopy | undefined;
    let snapOff = false;
    if (copyParagraph) {
      try {
        const ooxml = source.getOoxml();
        await context.sync();
        // getOoxml returns a ClientResult filled by the sync above.
        // eslint-disable-next-line office-addins/load-object-before-read
        const reading = readParagraphLineSpacing(ooxml.value || "");
        snapOff = reading.snapOff;
        if (reading.line !== null || reading.lineRule !== null) {
          lineCopy = { line: reading.line, lineRule: reading.lineRule };
        }
      } catch {
        lineCopy = undefined;
      }
    }

    const note = `${destinations.length} 段落に書式を写しました（変更履歴に書式変更として記録）。`;
    if (!copiedParagraph) {
      await context.sync();
      return note;
    }
    const fields: ParagraphFormatFields = { ...copiedParagraph };
    if (!snapOff) {
      delete fields.lineSpacing;
    }
    const options = paragraphOoxmlOptions({ quote: "", ...fields });
    if (options && snapOff && lineCopy) {
      options.unsetLineGrid = true;
      options.lineCopy = lineCopy;
    }
    for (const paragraph of destinations) {
      paintParagraphFields(paragraph, copiedParagraph);
      if (lineUnitBefore !== undefined) {
        paragraph.lineUnitBefore = lineUnitBefore;
      }
      if (lineUnitAfter !== undefined) {
        paragraph.lineUnitAfter = lineUnitAfter;
      }
    }
    await context.sync();
    if (!options) {
      return note;
    }
    const extra = await rewriteParagraphOoxml(context, destinations, options);
    return withCountNote(note, extra);
  });
}

function paragraphOoxmlOptions(args: FormatParagraphArgs): ParagraphFormatOptions | null {
  const options: ParagraphFormatOptions = {};
  if (args.lineSpacing !== undefined) {
    options.unsetLineGrid = true;
  }
  if (args.spaceBefore !== undefined) {
    options.spaceBeforePt = args.spaceBefore;
  }
  if (args.spaceAfter !== undefined) {
    options.spaceAfterPt = args.spaceAfter;
  }
  if (args.leftIndent !== undefined || args.firstLineIndent !== undefined) {
    options.indent = {
      leftPt: args.leftIndent,
      firstLinePt: args.firstLineIndent,
      fontPt: 12,
    };
  }
  if (
    !options.unsetLineGrid &&
    options.spaceBeforePt === undefined &&
    options.spaceAfterPt === undefined &&
    !options.indent
  ) {
    return null;
  }
  return options;
}

/**
 * Line spacing below the document grid does nothing while snap-to-grid is on,
 * and Auto before/after spacing ignores the point values Word.js writes.
 * Office.js cannot clear those flags, so the paragraph OOXML is patched instead.
 * Tracking is off for the rewrite so the clause is not recorded as delete+insert.
 */
async function rewriteCopiedLineSpacing(
  context: Word.RequestContext,
  created: { paragraph: Word.Paragraph; spec: ParagraphSpec }[]
): Promise<void> {
  const reads = created.map((entry) => ({
    entry,
    ooxml: entry.paragraph.getOoxml(),
  }));
  await context.sync();
  const writes: { paragraph: Word.Paragraph; ooxml: string }[] = [];
  for (const read of reads) {
    const copy = read.entry.spec.spacingCopy;
    if (!copy) {
      continue;
    }
    const patched = patchParagraphFormat(read.ooxml.value || "", {
      unsetLineGrid: true,
      lineCopy: copy,
    });
    if (patched.changed) {
      writes.push({ paragraph: read.entry.paragraph, ooxml: patched.ooxml });
    }
  }
  if (!writes.length) {
    return;
  }
  context.document.changeTrackingMode = Word.ChangeTrackingMode.off;
  try {
    for (const write of writes) {
      write.paragraph.insertOoxml(write.ooxml, Word.InsertLocation.replace);
    }
    await context.sync();
  } catch {
    // The point size still stands. The sample's line rule could not be copied.
  } finally {
    startTracking(context);
  }
  try {
    await context.sync();
  } catch {
    // The next edit turns tracking back on.
  }
}

async function rewriteParagraphOoxml(
  context: Word.RequestContext,
  paragraphs: Word.Paragraph[],
  options: ParagraphFormatOptions
): Promise<string> {
  const reads = paragraphs.map((paragraph) => ({
    paragraph,
    ooxml: paragraph.getOoxml(),
  }));
  await context.sync();

  const writes: { paragraph: Word.Paragraph; ooxml: string }[] = [];
  let lineGrid = false;
  let autoSpacing = false;
  for (const read of reads) {
    // getOoxml returns a ClientResult filled by the sync above.
    // eslint-disable-next-line office-addins/load-object-before-read
    const indent = options.indent
      ? { ...options.indent, fontPt: fontPtOf(read.paragraph) }
      : undefined;
    const patched = patchParagraphFormat(read.ooxml.value || "", { ...options, indent });
    if (patched.changed) {
      writes.push({ paragraph: read.paragraph, ooxml: patched.ooxml });
      lineGrid = lineGrid || patched.lineGrid;
      autoSpacing = autoSpacing || patched.autoSpacing;
    }
  }
  if (!writes.length) {
    return "";
  }

  const notes: string[] = [];
  if (lineGrid) {
    notes.push("対象段落の行グリッドへの合わせは外しました。");
  }
  if (autoSpacing) {
    notes.push("段落前・後の自動間隔を外して指定値にしました。");
  }
  let note = notes.join(" ");
  context.document.changeTrackingMode = Word.ChangeTrackingMode.off;
  try {
    for (const write of writes) {
      write.paragraph.insertOoxml(write.ooxml, Word.InsertLocation.replace);
    }
    await context.sync();
  } catch {
    note = ooxmlFailNote(options);
  } finally {
    startTracking(context);
  }
  try {
    await context.sync();
  } catch {
    // The next edit turns tracking back on.
  }
  return note;
}

function fontPtOf(paragraph: Word.Paragraph): number {
  try {
    const size = paragraph.font.size;
    return typeof size === "number" && size > 0 ? size : 12;
  } catch {
    return 12;
  }
}

function ooxmlFailNote(options: ParagraphFormatOptions): string {
  const grid = Boolean(options.unsetLineGrid);
  const spacing = options.spaceBeforePt !== undefined || options.spaceAfterPt !== undefined;
  if (grid && spacing) {
    return "行グリッドまたは段落前後の間隔を変えられなかったので、見た目が変わらないことがあります。";
  }
  if (grid) {
    return "行グリッドを外せなかったので、見た目の行間が変わらないことがあります。";
  }
  if (options.indent && !spacing) {
    return "インデントを書き込めなかったので、字下げやぶら下げがずれることがあります。";
  }
  return "段落前後の自動間隔を外せなかったので、指定した間隔が効かないことがあります。";
}

function isListed(paragraph: Word.Paragraph): boolean {
  try {
    return Boolean(paragraph.isListItem);
  } catch {
    return false;
  }
}

/**
 * The list `continue` joins, which may sit above blank lines or 号 paragraphs
 * that are body text. The immediately previous paragraph is the wrong place
 * to look: a second 項 then starts a new list at 1.
 */
function previousListParagraph(
  items: Word.Paragraph[],
  fromIndex: number
): Word.Paragraph | null {
  for (let index = fromIndex - 1; index >= 0; index -= 1) {
    if (isNumberMark(listMarkOf(items[index]))) {
      return items[index];
    }
  }
  return null;
}

function listIdOf(paragraph: Word.Paragraph): number | null {
  try {
    if (!paragraph.isListItem) {
      return null;
    }
    const list = paragraph.listOrNullObject;
    if (!list || list.isNullObject) {
      return null;
    }
    return list.id;
  } catch {
    return null;
  }
}

function listLevelOf(paragraph: Word.Paragraph): number {
  try {
    if (!paragraph.isListItem) {
      return 0;
    }
    const item = paragraph.listItemOrNullObject;
    if (!item || item.isNullObject) {
      return 0;
    }
    return item.level || 0;
  } catch {
    return 0;
  }
}

function shownListString(paragraph: Word.Paragraph): string {
  return wrapListMark(listMarkOf(paragraph)) || "（なし）";
}

function setNumberingListStyle(list: Word.List, style: ListStyle, level: number): void {
  const spec = listStyleSpec(style);
  if (spec.numbering === "paren") {
    list.setLevelNumbering(level, Word.ListNumbering.arabic, ["(", level, ")"]);
    return;
  }
  if (spec.numbering === "lowerLetter") {
    list.setLevelNumbering(level, Word.ListNumbering.lowerLetter);
    return;
  }
  list.setLevelNumbering(level, Word.ListNumbering.arabic);
}

async function applyBuiltinListStyle(
  context: Word.RequestContext,
  paragraph: Word.Paragraph,
  style: ListStyle,
  level: number
): Promise<void> {
  const builtin = listStyleSpec(style).builtin;
  if (!builtin) {
    throw new Error(`内部エラー: ${style} は組み込み番号書式ではありません。`);
  }
  const listLevels = paragraph.getRange().listFormat.listTemplate.listLevels;
  listLevels.load("items");
  await context.sync();
  const listLevel = listLevels.items[level];
  if (!listLevel) {
    throw new Error(`リストレベル ${level} が見つかりません。`);
  }
  // A bullet level only accepts a one-character label, and Word rewrites
  // numberFormat whenever numberStyle changes. Both mean the style has to land
  // first, in its own sync, before the label is worth setting.
  listLevel.numberStyle = builtin.numberStyle as Word.ListBuiltInNumberStyle;
  await context.sync();
  listLevel.numberFormat = listLevelNumberFormat(builtin, level);
  if (builtin.trailingCharacter) {
    listLevel.trailingCharacter = builtin.trailingCharacter as Word.TrailingCharacter;
  }
  await context.sync();
}

function resolveApplyStyle(style: ListStyle): ListStyle {
  return style === "continue" ? "arabic" : style;
}

/**
 * Put `targets` on the list `previous` belongs to, at `level`. Word counts
 * within one list, so this is what makes the second 項 read ２ and a 号 keep
 * counting past its 目. The tool logs show attachToList doing exactly that
 * (１→２→３, （１）→（２）, ①→②) whenever the paragraph above was actually found.
 */
function joinListOf(previous: Word.Paragraph, targets: Word.Paragraph[], level: number): void {
  const id = listIdOf(previous);
  if (id === null) {
    throw new Error("直前の番号リストが読めませんでした。");
  }
  for (const paragraph of targets) {
    paragraph.attachToList(id, level);
  }
}

/**
 * The object in `items` that stands for `paragraph`. A range found by quote
 * hands back paragraph proxies of its own, and `items.indexOf` cannot see
 * through them: it answered -1, so no "numbered paragraph above" was ever
 * found for a quote-addressed paragraph, and each one began a list of its own
 * and read １ / （１） / ① however far down its 条 it stood. Paragraph numbers
 * come straight from `items` and never had the problem.
 */
async function anchorInBody(
  context: Word.RequestContext,
  items: Word.Paragraph[],
  paragraph: Word.Paragraph
): Promise<Word.Paragraph> {
  if (items.includes(paragraph)) {
    return paragraph;
  }
  const wanted = compact(paragraphText(paragraph));
  const candidates = items.filter((item) => compact(paragraphText(item)) === wanted);
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (!candidates.length) {
    throw new Error(
      "対象の段落を本文の中で特定できませんでした。paragraph に添付本文の段落番号を渡してください。"
    );
  }
  // Same wording more than once: ask Word which of them is this very range.
  const target = paragraph.getRange();
  const relations = candidates.map((item) => item.getRange().compareLocationWith(target));
  await context.sync();
  const index = relations.findIndex(
    (relation) => relation.value === Word.LocationRelation.equal
  );
  if (index < 0) {
    throw new Error(
      "同じ文言の段落が複数あり、どれかを特定できませんでした。paragraph に添付本文の段落番号を渡してください。"
    );
  }
  return candidates[index];
}

function landingNote(paragraphs: Word.Paragraph[], joinedFrom: Word.Paragraph | null = null): string {
  const first = paragraphs[0];
  const last = paragraphs[paragraphs.length - 1];
  const head = clipNote(paragraphText(first), 24);
  const lead = joinedFrom ? `直前の ${shownListString(joinedFrom)} に続けました。` : "";
  if (paragraphs.length === 1) {
    return `${lead}「${head}」を対象にしました。いま Word に出ている番号は ${shownListString(first)} です。`;
  }
  const tail = clipNote(paragraphText(last), 24);
  return (
    `${lead}${paragraphs.length} 段落（「${head}」〜「${tail}」）を対象にしました。` +
    `いま Word に出ている番号は、先頭が ${shownListString(first)}、末尾が ${shownListString(last)} です。`
  );
}

async function loadListMembership(
  context: Word.RequestContext,
  paragraphs: Word.Paragraph[]
): Promise<void> {
  const listed: Word.Paragraph[] = [];
  for (const paragraph of paragraphs) {
    try {
      if (paragraph.isListItem) {
        listed.push(paragraph);
      }
    } catch {
      // Membership stays unread.
    }
  }
  if (!listed.length) {
    return;
  }
  try {
    for (const paragraph of listed) {
      paragraph.listItemOrNullObject.load("listString,level");
      paragraph.listOrNullObject.load("id,levelTypes");
    }
    await context.sync();
  } catch {
    // Membership stays unread. Callers treat missing ids as "not a list".
  }
}

/**
 * The non-blank paragraphs from `fromIndex` through `toIndex`. Each has to be
 * one the model was shown — attached, or handed out by an insert this turn — so
 * a span cannot edit paragraphs past where the attachment was cut off. That
 * is checked by wording, not by position: an insert above moves everything
 * below it, so a body position no longer says which number a paragraph wore.
 */
function spanListTargets(
  items: Word.Paragraph[],
  fromIndex: number,
  toIndex: number
): Word.Paragraph[] {
  if (toIndex < fromIndex) {
    throw new Error("through は paragraph と同じか、それより後ろの番号にしてください。");
  }
  const shown = new Set([...attachedParagraphs.values()].map((row) => compact(row.text)));
  const targets: Word.Paragraph[] = [];
  for (let index = fromIndex; index <= toIndex; index += 1) {
    const text = paragraphText(items[index]);
    if (!text.trim()) {
      continue;
    }
    if (shown.size > 0 && !shown.has(compact(text))) {
      throw new Error(
        `「${clipNote(text, 24)}」は今回の添付に無いので、この区間は操作できません。` +
          `添付されている番号の区間だけを through に渡してください。`
      );
    }
    targets.push(items[index]);
  }
  if (!targets.length) {
    throw new Error("対象の段落がありません。");
  }
  return targets;
}

/**
 * Put `targets` on a numbered list at `level` and give that level its style.
 * Joining the list above is what makes 項・号・目 one hierarchy: Word advances
 * the outer counter and restarts the inner one only within a single list, so a
 * 号 that starts its own list always reads （１）. `previous` is the numbered
 * paragraph above whose list is joined; null only at the top of a 条, where
 * the count is meant to begin again.
 */
async function buildNumberedList(
  context: Word.RequestContext,
  targets: Word.Paragraph[],
  style: ListStyle,
  level: number,
  previous: Word.Paragraph | null
): Promise<void> {
  const applyStyle = resolveApplyStyle(style);
  if (isBuiltinListStyle(applyStyle) && !canApplyBuiltinListStyles()) {
    throw new Error(
      `${applyStyle} などの番号書式には Word デスクトップが必要です。arabic / paren / lowerLetter を使うか、Word デスクトップで開いてください。`
    );
  }

  // Styling a level rewrites the list template, which restarts that level's
  // count — the one thing a joining paragraph must not do. The level is styled
  // once, when it first comes into use; read before attaching, or it always
  // looks used. levelExistences is true where the list already has an item.
  let levelInUse = false;
  let createdId: number | null = null;
  if (previous === null) {
    const created = targets[0].startNewList();
    await context.sync();
    created.load("id");
    await context.sync();
    createdId = created.id;
  } else {
    const joinedId = listIdOf(previous);
    if (joinedId !== null) {
      const joined = context.document.body.lists.getByIdOrNullObject(joinedId);
      joined.load("isNullObject,levelExistences");
      await context.sync();
      levelInUse = !joined.isNullObject && joined.levelExistences[level] === true;
    }
  }
  try {
    if (previous === null) {
      if (level) {
        targets[0].listItem.level = level;
      }
      for (const paragraph of targets.slice(1)) {
        paragraph.attachToList(createdId as number, level);
      }
    } else {
      joinListOf(previous, targets, level);
    }
    // The paragraphs have to sit on the level before its template is rewritten,
    // so that Word reads the label back onto them.
    await context.sync();
    if (!levelInUse) {
      if (isBuiltinListStyle(applyStyle)) {
        await applyBuiltinListStyle(context, targets[0], applyStyle, level);
      } else {
        setNumberingListStyle(targets[0].list, applyStyle, level);
        await context.sync();
      }
    }
  } catch (error) {
    for (const paragraph of targets) {
      try {
        paragraph.detachFromList();
      } catch {
        // Already plain, or Word refused the detach.
      }
    }
    try {
      await context.sync();
    } catch {
      // The next edit sees whatever Word kept.
    }
    const reason = error instanceof Error ? error.message : "InvalidArgument";
    throw new Error(
      `番号の書式を付けられませんでした（${reason}）。箇条書きのまま残さないよう外しました。style を ${listStyleNamesForApply()} のいずれかにするか、1 段落ずつ付けてください。`
    );
  }
}

async function reloadListState(
  context: Word.RequestContext,
  paragraphs: Word.Paragraph[]
): Promise<void> {
  for (const paragraph of paragraphs) {
    paragraph.load("isListItem");
  }
  await context.sync();
  await loadListMembership(context, paragraphs);
}

/**
 * Attach, detach or restart Word automatic numbering. The model points by
 * paragraph number; Word list ids stay inside this function.
 */
export async function formatList(args: FormatListArgs): Promise<string> {
  return Word.run(async (context) => {
    startTracking(context);
    const collection = context.document.body.paragraphs;
    collection.load("items/text,items/isListItem");
    await context.sync();
    await loadListMembership(context, collection.items);
    const items = collection.items;

    let targets: Word.Paragraph[];
    if (args.paragraph !== undefined) {
      targets = [locateParagraph(items, args.paragraph).paragraph];
    } else {
      const target = await resolveTarget(context, args, "paragraph");
      const ranged = target.range.paragraphs;
      ranged.load("items/text,items/isListItem");
      await context.sync();
      const found = ranged.items.filter((paragraph) => paragraphText(paragraph).trim());
      if (!found.length) {
        throw new Error("対象の段落がありません。");
      }
      // Everything below reads list state and neighbours off `items`, so the
      // targets have to be those objects, not the range's own proxies.
      targets = [];
      for (const paragraph of found) {
        targets.push(await anchorInBody(context, items, paragraph));
      }
    }
    if (args.through !== undefined) {
      // The span runs from the first paragraph found, by number or by quote.
      const fromIndex = items.indexOf(targets[0]);
      const toIndex = locateParagraph(items, args.through).index;
      targets = spanListTargets(items, fromIndex, toIndex);
    }

    if (args.action === "remove") {
      for (const paragraph of targets) {
        if (paragraph.isListItem) {
          paragraph.detachFromList();
        }
      }
      await context.sync();
      await reloadListState(context, targets);
      return landingNote(targets);
    }

    if (args.action === "restart") {
      if (targets.length !== 1) {
        throw new Error("restart は 1 段落だけを対象にします。");
      }
      const paragraph = targets[0];
      if (!paragraph.isListItem) {
        throw new Error(
          "この段落に番号が無いので、1 から振り直せません。番号をここから 1 で始めるなら、apply に start を true で付けてください。"
        );
      }
      if (isBulletMark(listMarkOf(paragraph))) {
        throw new Error(
          `この段落は箇条書きです。1 から振り直す操作は番号リスト向けです。番号にするときは ${listStyleNamesForApply()} を付けてください。`
        );
      }
      const index = items.indexOf(paragraph);
      const id = listIdOf(paragraph);
      const previousListed = previousListParagraph(items, index);
      const firstInList = !previousListed || listIdOf(previousListed) !== id;
      if (firstInList) {
        paragraph.list.setLevelStartingNumber(listLevelOf(paragraph), 1);
        await context.sync();
        await reloadListState(context, [paragraph]);
        return landingNote([paragraph]);
      }
      if (canSeparateList()) {
        paragraph.separateList();
        await context.sync();
        await reloadListState(context, [paragraph]);
        return landingNote([paragraph]);
      }
      const following: Word.Paragraph[] = [];
      for (let after = index + 1; after < items.length; after += 1) {
        if (listIdOf(items[after]) === id) {
          following.push(items[after]);
        }
      }
      const level = listLevelOf(paragraph);
      paragraph.detachFromList();
      for (const next of following) {
        next.detachFromList();
      }
      await context.sync();
      await buildNumberedList(context, [paragraph, ...following], "arabic", level, null);
      await reloadListState(context, [paragraph]);
      return (
        landingNote([paragraph]) +
        " 元の番号の書式は保てなかったので、アラビア数字になっています。"
      );
    }

    const style: ListStyle = args.style || "continue";
    const first = targets[0];
    const firstIndex = items.indexOf(first);
    const previous = previousListParagraph(items, firstIndex);
    const previousId = previous ? listIdOf(previous) : null;
    const continueLevel =
      args.level !== undefined
        ? args.level
        : previous
          ? listLevelOf(previous)
          : 0;

    if (style !== "continue") {
      if (targets.some((paragraph) => isNumberMark(listMarkOf(paragraph)))) {
        throw new Error(
          `既に項番号（1. や （１） や 第１ や 第１条 など）があります。外してから ${listStyleNamesForApply()} を付けるか、continue で続きにしてください。`
        );
      }
      const bullets = targets.filter((paragraph) => isBulletMark(listMarkOf(paragraph)));
      if (bullets.length) {
        for (const paragraph of bullets) {
          paragraph.detachFromList();
        }
        await context.sync();
      }
      // A new list is only right where the count starts over; otherwise the
      // paragraph joins the numbering already running above it.
      const joinedFrom = args.start || previousId === null ? null : previous;
      await buildNumberedList(context, targets, style, args.level ?? 0, joinedFrom);
      await reloadListState(context, targets);
      return landingNote(targets, joinedFrom);
    }

    if (previousId !== null) {
      for (const paragraph of targets) {
        const id = listIdOf(paragraph);
        if (id !== null && id !== previousId) {
          throw new Error(
            "対象は別のリストの番号があります。外してから続けるか、remove してから付け直してください。"
          );
        }
      }
      if (targets.every((paragraph) => listIdOf(paragraph) === previousId)) {
        await reloadListState(context, targets);
        return landingNote(targets);
      }
      // A level nobody has used yet still wears the template default, which
      // startNewList leaves as a bullet. Joining it would hand back 〔•〕.
      const joined = context.document.body.lists.getByIdOrNullObject(previousId);
      joined.load("isNullObject,levelExistences");
      await context.sync();
      if (!joined.isNullObject && joined.levelExistences[continueLevel] !== true) {
        throw new Error(
          `段 ${continueLevel} にはまだ番号の書式がありません。continue は同じ段の続きに使い、段を変えるときは style を付けた apply にしてください。`
        );
      }
      for (const paragraph of targets) {
        if (paragraph.isListItem) {
          paragraph.detachFromList();
        }
      }
      await context.sync();
      joinListOf(previous as Word.Paragraph, targets, continueLevel);
      await context.sync();
      await reloadListState(context, targets);
      return landingNote(targets, previous);
    }

    const ids = targets.map((paragraph) => listIdOf(paragraph));
    const listed = ids.filter((id) => id !== null);
    if (listed.length === targets.length && new Set(listed).size === 1) {
      return landingNote(targets);
    }
    if (listed.length) {
      throw new Error(
        "対象の一部にすでに番号があります。外してから付けるか、番号の無い段落だけを選んでください。"
      );
    }
    await buildNumberedList(context, targets, "arabic", continueLevel, null);
    await reloadListState(context, targets);
    return landingNote(targets);
  });
}

/** Body text. Levels 1 to 9 show in the navigation pane. Same numbers as WdOutlineLevel. */
const OUTLINE_BODY_LEVEL = 10;

const BUILTIN_HEADING_STYLES = new Set([
  "Heading1",
  "Heading2",
  "Heading3",
  "Heading4",
  "Heading5",
  "Heading6",
  "Heading7",
  "Heading8",
  "Heading9",
]);

function readOutlineLevel(value: number | string): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (value === "OutlineLevelBodyText") {
    return OUTLINE_BODY_LEVEL;
  }
  const match = /^OutlineLevel([1-9])$/.exec(value);
  return match ? Number(match[1]) : null;
}

function isBuiltinHeadingStyle(style: string): boolean {
  return BUILTIN_HEADING_STYLES.has(style);
}

function quotedClips(paragraphs: Word.Paragraph[]): string {
  return paragraphs.map((paragraph) => `「${clipNote(paragraphText(paragraph), 24)}」`).join("、");
}

function outlineAppliedNote(paragraphs: Word.Paragraph[], wanted: number): string {
  const verb =
    wanted === OUTLINE_BODY_LEVEL
      ? "ナビゲーションの見出しから外しました（変更履歴に書式変更として記録）。"
      : `レベル ${wanted} の見出しにしました（変更履歴に書式変更として記録）。`;
  if (paragraphs.length === 1) {
    return `「${clipNote(paragraphText(paragraphs[0]), 24)}」を${verb}`;
  }
  const head = clipNote(paragraphText(paragraphs[0]), 24);
  const tail = clipNote(paragraphText(paragraphs[paragraphs.length - 1]), 24);
  return `${paragraphs.length} 段落（「${head}」〜「${tail}」）を${verb}`;
}

/**
 * Navigation headings are outline levels, not heading styles. This writes only
 * `outlineLevel`, so the paragraph style and font stay. Built-in Heading 1-9
 * lock that level to the style, so those paragraphs are skipped.
 */
export async function setOutlineLevel(args: SetOutlineArgs): Promise<string> {
  const wanted = args.action === "clear" ? OUTLINE_BODY_LEVEL : args.level;
  if (wanted === undefined) {
    throw new Error("set には level（1 から 9）が必要です。");
  }
  return Word.run(async (context) => {
    startTracking(context);
    const collection = context.document.body.paragraphs;
    collection.load("items/text");
    await context.sync();
    const items = collection.items;

    let targets: Word.Paragraph[];
    if (args.paragraph !== undefined) {
      targets = [locateParagraph(items, args.paragraph).paragraph];
    } else {
      const target = await resolveTarget(context, args, "paragraph");
      const ranged = target.range.paragraphs;
      ranged.load("items/text");
      await context.sync();
      const found = ranged.items.filter((paragraph) => paragraphText(paragraph).trim());
      if (!found.length) {
        throw new Error("対象の段落がありません。");
      }
      targets = [];
      for (const paragraph of found) {
        targets.push(await anchorInBody(context, items, paragraph));
      }
    }
    if (args.through !== undefined) {
      const fromIndex = items.indexOf(targets[0]);
      const toIndex = locateParagraph(items, args.through).index;
      targets = spanListTargets(items, fromIndex, toIndex);
    }

    for (const paragraph of targets) {
      paragraph.load("styleBuiltIn,outlineLevel,style");
    }
    await context.sync();

    const locked: Word.Paragraph[] = [];
    const same: Word.Paragraph[] = [];
    const writes: { paragraph: Word.Paragraph; styleBefore: string }[] = [];
    for (const paragraph of targets) {
      if (isBuiltinHeadingStyle(String(paragraph.styleBuiltIn))) {
        locked.push(paragraph);
        continue;
      }
      const current = readOutlineLevel(paragraph.outlineLevel);
      if (current === wanted) {
        same.push(paragraph);
        continue;
      }
      writes.push({ paragraph, styleBefore: paragraph.style });
      paragraph.outlineLevel = wanted;
    }

    if (writes.length) {
      await context.sync();
      for (const write of writes) {
        write.paragraph.load("outlineLevel,style");
      }
      await context.sync();
    }

    const stuck: Word.Paragraph[] = [];
    const missed: Word.Paragraph[] = [];
    const restyled: { paragraph: Word.Paragraph; styleBefore: string }[] = [];
    for (const write of writes) {
      if (write.paragraph.style !== write.styleBefore) {
        restyled.push(write);
        continue;
      }
      if (readOutlineLevel(write.paragraph.outlineLevel) === wanted) {
        stuck.push(write.paragraph);
      } else {
        missed.push(write.paragraph);
      }
    }
    if (restyled.length) {
      const first = restyled[0];
      throw new Error(
        `${quotedClips(restyled.map((write) => write.paragraph))}のスタイル名が` +
          `「${first.styleBefore}」から「${first.paragraph.style}」に変わりました。取り消してください。`
      );
    }

    const parts: string[] = [];
    if (stuck.length) {
      parts.push(outlineAppliedNote(stuck, wanted));
    }
    if (missed.length) {
      parts.push(`${quotedClips(missed)}はナビゲーションに出ていません。`);
    }
    if (locked.length) {
      parts.push(
        `${quotedClips(locked)}は組み込みの見出しスタイルがレベルを固定しているので変えていません。`
      );
    }
    if (!stuck.length && !missed.length && same.length) {
      parts.push(
        wanted === OUTLINE_BODY_LEVEL
          ? `${quotedClips(same)}はすでにナビゲーションの見出しではありません。`
          : `${quotedClips(same)}はすでにレベル ${wanted} です。`
      );
    }
    if (missed.length && !stuck.length) {
      throw new Error(parts.join(""));
    }
    if (!parts.length) {
      throw new Error("対象の段落がありません。");
    }
    return parts.join("");
  });
}

export async function insertCitationComment(hit: SearchHit): Promise<void> {
  await Word.run(async (context) => {
    const selection = context.document.getSelection();
    selection.insertComment(truncateComment(formatCitation(hit)));
    await context.sync();
  });
}

export async function insertCitationText(hit: SearchHit): Promise<void> {
  await Word.run(async (context) => {
    startTracking(context);
    const selection = context.document.getSelection();
    const paragraph = selection.insertParagraph(formatCitation(hit), Word.InsertLocation.after);
    paragraph.load("isListItem");
    await context.sync();
    if (paragraph.isListItem) {
      paragraph.detachFromList();
      await context.sync();
    }
  });
}

/** Stable per-document key so a conversation can be reopened with its document. */
export function getDocumentKey(settingName: string): string {
  const settings = Office.context.document.settings;
  const existing = settings.get(settingName);
  if (typeof existing === "string" && existing) {
    return existing;
  }
  const created = `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  settings.set(settingName, created);
  settings.saveAsync();
  return created;
}

const FULL_READ_PARAGRAPHS = 40;
const FULL_READ_CHARS = 8_000;
const MARKS_READ_CHARS = 12_000;
const FIND_READ_CHARS = 8_000;

type LiveParagraph = {
  paragraph: Word.Paragraph;
  index: number;
  raw: string;
  reviewed: string;
  mark: ListMark;
  styleName: string;
  styleBuiltIn: string;
  outline: number | null;
};

type NumberedLive = { number: number; live: LiveParagraph };

export type ParagraphRead = { text: string; numbered: boolean };

function isPresent(live: LiveParagraph): boolean {
  return Boolean(live.reviewed.trim());
}

function nextAddress(): number {
  let max = 0;
  for (const number of attachedParagraphs.keys()) {
    if (number > max) {
      max = number;
    }
  }
  return max + 1;
}

/**
 * Pair each remembered paragraph with the live one `locateParagraph` would find,
 * then give every other present paragraph a new number past the high water.
 * Existing numbers stay. The same text uses each remembered number once.
 */
function claimNumbers(lives: LiveParagraph[]): { rows: NumberedLive[]; handedOut: boolean } {
  const hadNone = attachedParagraphs.size === 0;
  const claimed = new Map<LiveParagraph, number>();
  const numbers = [...attachedParagraphs.keys()].sort((a, b) => a - b);
  for (const number of numbers) {
    const row = attachedParagraphs.get(number);
    if (!row) {
      continue;
    }
    const target = compact(row.text);
    if (!target || lives.length === 0) {
      continue;
    }
    const from = Math.min(Math.max(number - 1, 0), lives.length - 1);
    let found: LiveParagraph | undefined;
    for (let step = 0; step < lives.length && !found; step += 1) {
      const indexes = step === 0 ? [from] : [from + step, from - step];
      for (const index of indexes) {
        if (index < 0 || index >= lives.length) {
          continue;
        }
        const live = lives[index];
        if (claimed.has(live) || !isPresent(live)) {
          continue;
        }
        if (compact(live.raw) === target || compact(live.reviewed) === target) {
          found = live;
          break;
        }
      }
    }
    if (found) {
      claimed.set(found, number);
    }
  }

  const rows: NumberedLive[] = [];
  let handedOut = false;
  let fresh = nextAddress();
  for (const live of lives) {
    if (!isPresent(live)) {
      continue;
    }
    const existing = claimed.get(live);
    if (existing !== undefined) {
      rows.push({ number: existing, live });
      continue;
    }
    const number = hadNone ? live.index + 1 : fresh;
    if (!hadNone) {
      fresh += 1;
    }
    attachedParagraphs.set(number, {
      text: live.raw,
      shown: live.reviewed,
      listString: live.mark.listString,
      isListItem: live.mark.isListItem,
    });
    handedOut = true;
    rows.push({ number, live });
  }
  if (hadNone && rows.length) {
    attachedParagraphCount = lives.length;
  }
  return { rows, handedOut: handedOut || (hadNone && rows.length > 0) };
}

/** Drop remembered paragraphs that no longer match live text, so their numbers cannot fall through to an index. */
function retireUnclaimed(rows: NumberedLive[]): void {
  const kept = new Set(rows.map((row) => row.number));
  let dropped = false;
  for (const number of [...attachedParagraphs.keys()]) {
    if (!kept.has(number)) {
      attachedParagraphs.delete(number);
      dropped = true;
    }
  }
  if (dropped) {
    attachedParagraphCount = Math.max(attachedParagraphCount, 0) + 1;
  }
}

async function loadLiveParagraphs(context: Word.RequestContext): Promise<LiveParagraph[]> {
  const collection = context.document.body.paragraphs;
  collection.load("items/text,items/isListItem");
  await context.sync();
  await loadListStrings(context, collection.items);

  let styled = true;
  try {
    for (const paragraph of collection.items) {
      paragraph.load("style,styleBuiltIn,outlineLevel");
    }
    await context.sync();
  } catch {
    styled = false;
  }

  const useReviewed = canReadReviewed();
  const reviewed: Array<{ value: string }> = [];
  if (useReviewed) {
    for (const paragraph of collection.items) {
      reviewed.push(paragraph.getReviewedText(Word.ChangeTrackingVersion.current) as { value: string });
    }
    try {
      await context.sync();
    } catch {
      reviewed.length = 0;
    }
  }

  return collection.items.map((paragraph, index) => {
    const raw = paragraphText(paragraph);
    const reviewedText = reviewed[index]
      ? paragraphText({ text: reviewed[index].value || "" })
      : raw;
    let styleName = "";
    let styleBuiltIn = "";
    let outline: number | null = null;
    if (styled) {
      try {
        styleName = String(paragraph.style || "");
        styleBuiltIn = String(paragraph.styleBuiltIn || "");
        outline = readOutlineLevel(paragraph.outlineLevel as number | string);
      } catch {
        styleName = "";
      }
    }
    return {
      paragraph,
      index,
      raw,
      reviewed: reviewedText,
      mark: listMarkOf(paragraph),
      styleName,
      styleBuiltIn,
      outline,
    };
  });
}

function markLabel(mark: ListMark): string {
  if (!mark.isListItem) {
    return "番号なし";
  }
  return wrapListMark(mark) || "番号あり";
}

function outlineNote(live: LiveParagraph): string {
  if (live.outline !== null && live.outline >= 1 && live.outline <= 9) {
    return `見出し:${live.outline}`;
  }
  return "";
}

function aroundMatch(text: string, needle: string): string {
  const want = compact(needle);
  const chars = [...text];
  let dense = "";
  const map: number[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    if (/[\s\u3000]/.test(chars[index])) {
      continue;
    }
    map.push(index);
    dense += chars[index];
  }
  const pos = dense.indexOf(want);
  if (pos < 0) {
    return clipNote(text, 60);
  }
  const startChar = map[Math.max(0, pos - 12)] ?? 0;
  const endIndex = Math.min(map.length - 1, pos + want.length - 1 + 12);
  const endChar = (map[endIndex] ?? text.length - 1) + 1;
  const prefix = startChar > 0 ? "…" : "";
  const suffix = endChar < text.length ? "…" : "";
  return `${prefix}${text.slice(startChar, endChar)}${suffix}`;
}

type CommentHit = { author: string; anchor: string; content: string };

async function loadCommentHits(context: Word.RequestContext): Promise<{ hits: CommentHit[]; error: string }> {
  try {
    const list = context.document.body.getComments();
    list.load("items/authorName,items/content");
    await context.sync();
    const anchors = list.items.map((comment) => {
      const range = comment.getRange();
      range.load("text");
      return range;
    });
    try {
      await context.sync();
    } catch {
      return {
        hits: list.items.map((comment) => ({
          author: comment.authorName || "",
          anchor: "",
          content: comment.content || "",
        })),
        error: "",
      };
    }
    return {
      hits: list.items.map((comment, index) => ({
        author: comment.authorName || "",
        anchor: anchors[index].text || "",
        content: comment.content || "",
      })),
      error: "",
    };
  } catch (error) {
    return { hits: [], error: readFailed(error) };
  }
}

function commentsOn(live: LiveParagraph, hits: CommentHit[]): string {
  const dense = compact(live.reviewed);
  if (!dense) {
    return "なし";
  }
  const matched = hits.filter((hit) => {
    const anchor = compact(hit.anchor);
    return Boolean(anchor) && (dense.includes(anchor) || anchor === dense);
  });
  if (!matched.length) {
    return "なし";
  }
  return matched.map((hit) => `${hit.author} ${hit.content}`.trim()).join(" / ");
}

function fullBlock(row: NumberedLive, comments: string): string {
  const style = `スタイル:${row.live.styleName || "標準"}`;
  const heading = outlineNote(row.live);
  const head = [`[${row.number}] ${markLabel(row.live.mark)}`, style, heading].filter(Boolean).join(" ");
  return `${head}\n${row.live.reviewed}\nコメント: ${comments}`;
}

function marksLine(row: NumberedLive): string {
  const extras = [
    isBuiltinHeadingStyle(row.live.styleBuiltIn) ? `スタイル:${row.live.styleName || row.live.styleBuiltIn}` : "",
    outlineNote(row.live),
  ].filter(Boolean);
  const head = `[${row.number}] ${markLabel(row.live.mark)}`;
  return extras.length ? `${head} ${extras.join(" ")}` : head;
}

function assertFindQuery(q: string): void {
  if (q.length > MAX_FIND_CHARS) {
    throw new Error(`検索語が ${MAX_FIND_CHARS} 字を超えています。Word の検索の上限です。短くしてください。`);
  }
  if (/[\r\n]/.test(q)) {
    throw new Error("検索語に改行は入れられません。1 行の語にしてください。");
  }
}

/**
 * The document as it is now, addressed with the same paragraph numbers as the attachment.
 * Paragraphs the attachment never reached get new numbers and stay addressable this turn.
 */
export async function readParagraphs(args: ReadParagraphsArgs): Promise<ParagraphRead> {
  if (!isWordHost()) {
    throw new Error("Word で開いてください。");
  }
  const view = args.view ?? "full";
  return Word.run(async (context) => {
    const lives = await loadLiveParagraphs(context);
    const { rows, handedOut } = claimNumbers(lives);
    retireUnclaimed(rows);
    const comments = view === "full" ? await loadCommentHits(context) : { hits: [], error: "" };

    let selected = rows;
    if (view === "full") {
      if (args.from === undefined) {
        throw new Error("full で読むときは from に段落番号を渡してください。");
      }
      const end = args.through ?? args.from;
      selected = rows.filter((row) => row.number >= args.from! && row.number <= end);
    } else if (args.from !== undefined) {
      const end = args.through ?? Number.POSITIVE_INFINITY;
      selected = rows.filter((row) => row.number >= args.from! && row.number <= end);
    }
    if (!rows.length) {
      return { text: "本文に段落がありません。", numbered: false };
    }
    if (!selected.length) {
      throw new Error(
        `段落 ${args.from} から読める段落がありません。read_paragraphs の view を marks にして番号を見てください。`
      );
    }

    const charCap = view === "marks" ? MARKS_READ_CHARS : FULL_READ_CHARS;
    const paraCap = view === "marks" ? Number.POSITIVE_INFINITY : FULL_READ_PARAGRAPHS;
    const blocks: string[] = [];
    let used = 0;
    for (const row of selected) {
      if (blocks.length >= paraCap) {
        break;
      }
      const block =
        view === "marks" ? marksLine(row) : fullBlock(row, commentsOn(row.live, comments.hits));
      if (blocks.length > 0 && used + block.length + 1 > charCap) {
        break;
      }
      blocks.push(block);
      used += block.length + 1;
    }
    const next = selected[blocks.length];
    const tail = next ? `\n…（続きは from を ${next.number} にしてください）` : "";
    const failed = comments.error ? `コメントは読めませんでした（${comments.error}）。無いとは限りません。\n` : "";
    const body = view === "marks" ? blocks.join("\n") : blocks.join("\n\n");
    return { text: `${failed}${body}${tail}`, numbered: handedOut };
  });
}

/**
 * Every current occurrence of a word, with the paragraph number a later edit can use.
 * List labels are not in paragraph.text, so they are matched on their own.
 */
export async function findInDocument(args: FindInDocumentArgs): Promise<ParagraphRead> {
  if (!isWordHost()) {
    throw new Error("Word で開いてください。");
  }
  const needle = args.q.trim();
  assertFindQuery(needle);
  return Word.run(async (context) => {
    const lives = await loadLiveParagraphs(context);
    const { rows, handedOut } = claimNumbers(lives);
    retireUnclaimed(rows);
    const wanted = compact(needle);
    const hits: Array<{ number: number; snippet: string }> = [];
    const seen = new Set<number>();

    const ranges = await findQuote(context, (options) => context.document.body.search(needle, options));
    const used = new Set<NumberedLive>();
    for (const range of ranges) {
      const collection = range.paragraphs;
      collection.load("items/text");
      await context.sync();
      const host = collection.items[0];
      if (!host) {
        continue;
      }
      const dense = compact(paragraphText(host));
      const row = rows.find((candidate) => !used.has(candidate) && compact(candidate.live.raw) === dense);
      if (!row || seen.has(row.number)) {
        continue;
      }
      if (args.after !== undefined && row.number <= args.after) {
        used.add(row);
        continue;
      }
      if (!compact(row.live.reviewed).includes(wanted)) {
        used.add(row);
        continue;
      }
      used.add(row);
      seen.add(row.number);
      hits.push({ number: row.number, snippet: aroundMatch(row.live.reviewed, needle) });
    }

    for (const row of rows) {
      if (seen.has(row.number)) {
        continue;
      }
      if (args.after !== undefined && row.number <= args.after) {
        continue;
      }
      const label = row.live.mark.listString;
      if (!label.trim() || !compact(label).includes(wanted)) {
        continue;
      }
      seen.add(row.number);
      const preview = clipNote(row.live.reviewed, 24);
      hits.push({ number: row.number, snippet: `${wrapListMark(row.live.mark)}${preview}` });
    }

    hits.sort((a, b) => a.number - b.number);
    if (!hits.length) {
      return { text: `「${clipNote(needle, 40)}」は本文にありません。`, numbered: handedOut };
    }

    const lines: string[] = [];
    let usedChars = 0;
    for (const hit of hits) {
      const line = `[${hit.number}] ${hit.snippet}`;
      if (lines.length > 0 && usedChars + line.length + 1 > FIND_READ_CHARS) {
        break;
      }
      lines.push(line);
      usedChars += line.length + 1;
    }
    const rest = hits.length - lines.length;
    const last = lines.length ? hits[lines.length - 1].number : hits[0].number;
    const more = rest > 0 ? `\nほか ${rest} 件。続きは after を ${last} にしてください。` : "";
    const head = `「${clipNote(needle, 40)}」は ${hits.length} 件`;
    return { text: `${head}\n${lines.join("\n")}${more}`, numbered: handedOut };
  });
}

function alreadyDeleted(number: number, lives: LiveParagraph[]): boolean {
  const remembered = attachedParagraphs.get(number);
  if (!remembered || !compact(remembered.text)) {
    return false;
  }
  const target = compact(remembered.text);
  return lives.some((live) => !isPresent(live) && (compact(live.raw) === target || compact(live.reviewed) === target));
}

/**
 * Delete whole paragraphs under tracked changes. Identical text is refused
 * until `follows` names the paragraph just before the copy to remove.
 */
export async function deleteParagraphs(args: DeleteParagraphsArgs): Promise<string> {
  if (!isWordHost()) {
    throw new Error("Word で開いてください。");
  }
  if (args.paragraphs.length > 8) {
    throw new Error("一度に消せるのは 8 段落までです。");
  }
  return Word.run(async (context) => {
    const lives = await loadLiveParagraphs(context);
    const { rows } = claimNumbers(lives);
    const byNumber = new Map(rows.map((row) => [row.number, row]));
    const gone: number[] = [];
    const targets: NumberedLive[] = [];

    for (const number of args.paragraphs) {
      const row = byNumber.get(number);
      if (!row) {
        if (alreadyDeleted(number, lives)) {
          gone.push(number);
          continue;
        }
        throw new Error(`段落 ${number} が見つかりません。read_paragraphs で読み直してください。`);
      }
      const key = compact(row.live.reviewed);
      const twins = rows.filter((candidate) => compact(candidate.live.reviewed) === key);
      if (twins.length > 1) {
        if (args.follows === undefined) {
          const lines = twins.map((twin) => {
            const at = rows.indexOf(twin);
            const prev = at > 0 ? rows[at - 1] : undefined;
            const where = prev
              ? `段落 ${prev.number}「${clipNote(prev.live.reviewed, 16)}」の次`
              : "文書の先頭";
            return `${where}（段落 ${twin.number}）`;
          });
          throw new Error(
            `同じ文言が ${twins.length} 箇所あります。消していません。\n${lines.join("\n")}\n` +
              "follows に、消したい方の直前の段落番号を渡してください。"
          );
        }
        const prev = byNumber.get(args.follows);
        if (!prev) {
          throw new Error(`段落 ${args.follows} が見つかりません。`);
        }
        const after = rows.find(
          (candidate) => candidate.live.index > prev.live.index && compact(candidate.live.reviewed) === key
        );
        if (!after) {
          throw new Error(`段落 ${args.follows} の後ろに、その文言はありません。`);
        }
        targets.push(after);
        continue;
      }
      targets.push(row);
    }

    if (gone.length && targets.length) {
      throw new Error(
        `段落 ${gone.join("、")} は削除済みです。ほかの段落は消していません。分けて指定してください。`
      );
    }
    if (gone.length) {
      retireUnclaimed(rows);
      return `段落 ${gone.join("、")} は削除済みです。`;
    }

    const unique = [...new Map(targets.map((target) => [target.number, target])).values()];
    unique.sort((a, b) => b.live.index - a.live.index);
    startTracking(context);
    for (const target of unique) {
      target.live.paragraph.delete();
      attachedParagraphs.delete(target.number);
    }
    await context.sync();
    attachedParagraphCount = lives.length + 1;
    retireUnclaimed(rows.filter((row) => attachedParagraphs.has(row.number)));
    const labels = [...unique]
      .sort((a, b) => a.number - b.number)
      .map((target) => `段落 ${target.number}「${clipNote(target.live.reviewed, 24)}」`);
    return (
      `${labels.join("、")}を削除しました（変更履歴に記録）。` +
      "この番号はもう使えません。続きは read_paragraphs で読み直してください。"
    );
  });
}

const SHAPE_TEXT_BOX = "TextBox";
const SHAPE_GEOMETRIC = "GeometricShape";
const SHAPE_GROUP = "Group";
const SHAPE_CANVAS = "Canvas";

/**
 * The installed `@types/office-js` has no `Word.Shape`. The desktop host does,
 * from WordApiDesktop 1.2, so the calls go through this narrow shape.
 */
type HostShape = {
  id: number;
  type: string;
  body: { text: string; load: (propertyNames: string) => void };
  shapeGroup: {
    isNullObject: boolean;
    shapes: { items: HostShape[] };
  };
  canvas: {
    isNullObject: boolean;
    shapes: { items: HostShape[] };
  };
  load: (propertyNames: string) => void;
  delete: () => void;
};

type HostShapeCollection = {
  items: HostShape[];
  load: (propertyNames?: string) => void;
};

type ShapeLeaf = { id: number; text: string; delete: () => void };

function childShapes(shape: HostShape): HostShape[] {
  try {
    if (shape.type === SHAPE_GROUP) {
      if (!shape.shapeGroup || shape.shapeGroup.isNullObject) {
        return [];
      }
      return shape.shapeGroup.shapes.items || [];
    }
    if (shape.type === SHAPE_CANVAS) {
      if (!shape.canvas || shape.canvas.isNullObject) {
        return [];
      }
      return shape.canvas.shapes.items || [];
    }
  } catch {
    return [];
  }
  return [];
}

/**
 * Text boxes and geometric shapes, in collection order. A group or canvas
 * contributes its children in that same order, which is the order the shape
 * section was numbered from the package.
 */
async function loadShapeLeaves(
  context: Word.RequestContext,
  shapes: HostShape[]
): Promise<ShapeLeaf[]> {
  if (!shapes.length) {
    return [];
  }
  for (const shape of shapes) {
    shape.load("type,id");
  }
  await context.sync();
  for (const shape of shapes) {
    if (shape.type === SHAPE_GROUP) {
      shape.load("shapeGroup/shapes/items");
    } else if (shape.type === SHAPE_CANVAS) {
      shape.load("canvas/shapes/items");
    } else if (shape.type === SHAPE_TEXT_BOX || shape.type === SHAPE_GEOMETRIC) {
      shape.body.load("text");
    }
  }
  await context.sync();
  const leaves: ShapeLeaf[] = [];
  for (const shape of shapes) {
    if (shape.type === SHAPE_GROUP || shape.type === SHAPE_CANVAS) {
      leaves.push(...(await loadShapeLeaves(context, childShapes(shape))));
    } else if (shape.type === SHAPE_TEXT_BOX || shape.type === SHAPE_GEOMETRIC) {
      leaves.push({ id: shape.id, text: shape.body.text || "", delete: () => shape.delete() });
    }
  }
  return leaves;
}

/**
 * Delete the text box numbered in this turn's shape section. Tracking stays
 * on, the same as every other edit. Older Word is told why, and the paragraph
 * is left alone.
 */
export async function deleteShape(args: DeleteShapeArgs): Promise<string> {
  if (!isWordHost()) {
    throw new Error("Word で開いてください。");
  }
  const number = args.shape;
  if (!Number.isInteger(number) || number < 1 || number > attachedShapes.length) {
    throw new Error(`図${number} はこのターンの図形節にありません。`);
  }
  if (spentShapes.has(number)) {
    throw new Error(`図${number} は削除済みです。この番号はもう使えません。`);
  }
  if (!canDeleteShapes()) {
    throw new Error("この Word ではテキストボックスを削除できません。");
  }
  return Word.run(async (context) => {
    const host = context.document.body as unknown as { shapes: HostShapeCollection };
    host.shapes.load("items");
    await context.sync();
    const leaves = (await loadShapeLeaves(context, host.shapes.items)).filter(
      (leaf) => !deletedShapeIds.has(leaf.id)
    );
    const pick = pickShapeByText(attachedShapes, leaves, number, spentShapes);
    if (!pick.ok) {
      throw new Error(
        `図${number} に一致するテキストボックスが見つかりません。ワードアートのように図形の本文を持たないものは削除できません。`
      );
    }
    startTracking(context);
    pick.shape.delete();
    await context.sync();
    spentShapes.add(number);
    deletedShapeIds.add(pick.shape.id);
    const first = attachedShapes[number - 1].split("\n")[0] || "";
    return `図${number}「${clipNote(first, 24)}」を削除しました（変更履歴に記録）。この番号はもう使えません。`;
  });
}

/** Word のファイル URL。未保存なら空。 */
export function getDocumentPath(): string {
  try {
    return (Office.context.document.url || "").trim();
  } catch {
    return "";
  }
}
