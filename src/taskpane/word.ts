import {
  Attachment,
  AttachmentScope,
  ChangeKind,
  ChangeNote,
  CommentNote,
  EMPTY_ATTACHMENT,
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
  ParagraphSpec,
  Severity,
  specPlainText,
} from "../shared/blocks";
import { MAX_CHANGES_READ, MAX_COMMENTS_READ, MAX_COMMENT_CHARS } from "../shared/constants";
import { FormatParagraphArgs, FormatTextArgs, InsertAtArg } from "../shared/tools";
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

export type DocumentStats = {
  chars: number;
  comments: number;
  changes: number;
  /** False when this Word is too old to read tracked changes at all. */
  changesAvailable: boolean;
};

/**
 * Sizes for the context meter and the composer readout. Cheap enough to run when
 * the pane opens, after a turn and when the picker opens, but not on every click.
 */
export async function getDocumentStats(): Promise<DocumentStats> {
  const empty = { chars: 0, comments: 0, changes: 0, changesAvailable: canReadChanges() };
  if (!isWordHost()) {
    return empty;
  }
  const chars = await Word.run(async (context) => {
    const body = context.document.body;
    body.load("text");
    await context.sync();
    return (body.text || "").length;
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
  return { ...empty, chars, comments, changes };
}

export type DocumentText = { text: string; paragraphs: number; truncated: boolean };

/**
 * The body, one paragraph per line, up to the budget. `paragraph.text` is the
 * same text `search` matches against, so a quote taken from here resolves later;
 * `getReviewedText` would read cleaner but would not.
 */
export async function readDocumentText(maxChars: number): Promise<DocumentText> {
  if (!isWordHost() || maxChars <= 0) {
    return { text: "", paragraphs: 0, truncated: false };
  }
  return Word.run(async (context) => {
    const paragraphs = context.document.body.paragraphs;
    paragraphs.load("items/text");
    await context.sync();

    const lines: string[] = [];
    let used = 0;
    let truncated = false;
    for (const paragraph of paragraphs.items) {
      // Word ends a paragraph with a carriage return, marks a soft break with a
      // vertical tab and a table cell with a bell.
      const line = (paragraph.text || "")
        .replaceAll("\r", "")
        .replaceAll("\u0007", "")
        .replaceAll("\u000b", " ");
      if (used + line.length + 1 > maxChars) {
        truncated = true;
        break;
      }
      lines.push(line);
      used += line.length + 1;
    }
    return { text: lines.join("\n"), paragraphs: lines.length, truncated };
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
    return { ...EMPTY_ATTACHMENT, scope };
  }
  const selected = await getSelectionText();
  const focus = selected.slice(0, Math.max(0, budget));
  const focusCut = focus.length < selected.length;

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
    return {
      scope,
      document: "",
      paragraphs: 0,
      truncated: focusCut,
      focus,
      markup,
      comments,
      changes,
    };
  }
  const remaining = budget - focus.length - markupUsed;
  const body = await readDocumentText(remaining);
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

export async function getSelectionInfo(): Promise<{ text: string; paragraphs: number }> {
  const text = await getSelectionText();
  // Word separates paragraphs with CR inside a range's text.
  const paragraphs = text.split(/\r\n?|\n/).filter((line) => line.trim()).length;
  return { text, paragraphs };
}

/**
 * Every model-driven edit is tracked, so the user can review or reject any of
 * it from Word itself. Formatting changes are recorded too.
 */
function startTracking(context: Word.RequestContext): void {
  context.document.changeTrackingMode = Word.ChangeTrackingMode.trackAll;
}

function assertSearchable(quote: string): void {
  if (quote.length > MAX_SEARCH_CHARS) {
    throw new Error(
      `引用が長すぎます（${MAX_SEARCH_CHARS}字まで）。短い引用にするか、選択範囲全体を対象にしてください。`
    );
  }
  if (/[\r\n]/.test(quote)) {
    throw new Error("引用が段落をまたいでいます。1 段落に収まる短い引用にしてください。");
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
    `「${needle}」が${where}に ${count} 箇所あります。どれか 1 箇所だけに当たるように、` +
      `同じ段落の中で前後を足した ${MAX_SEARCH_CHARS} 字までの引用にしてください。`
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

/**
 * Resolve what an operation applies to: the quoted text when given, otherwise
 * the whole selection. Quotes are looked for inside the selection first so a
 * repeated phrase elsewhere in the document is not hit by accident.
 */
async function resolveTarget(context: Word.RequestContext, quote: string): Promise<Word.Range> {
  const selection = context.document.getSelection();
  const needle = quote.trim();
  selection.load("text");
  await context.sync();

  if (!needle) {
    // Without a selection an empty range would edit nothing and report success.
    if (!(selection.text || "").trim()) {
      throw new Error(
        "選択範囲がありません。quote に本文どおりの短い引用を入れて、対象を指してください。"
      );
    }
    return selection;
  }
  assertSearchable(needle);

  if ((selection.text || "").trim()) {
    const inSelection = await findQuote(context, (options) => selection.search(needle, options));
    if (inSelection.length > 1) {
      throw ambiguousQuote(needle, inSelection.length, "選択範囲");
    }
    if (inSelection.length === 1) {
      return inSelection[0];
    }
  }

  const body = context.document.body;
  const inBody = await findQuote(context, (options) => body.search(needle, options));
  if (inBody.length > 1) {
    throw ambiguousQuote(needle, inBody.length, "本文");
  }
  if (inBody.length === 1) {
    return inBody[0];
  }

  throw new Error(
    `「${needle}」が本文に見つかりませんでした。本文どおりの短い引用にしてください。`
  );
}

export async function insertComment(
  comment: string,
  quote: string,
  severity: Severity
): Promise<void> {
  await Word.run(async (context) => {
    const target = await resolveTarget(context, quote);
    target.insertComment(truncateComment(formatComment(comment, severity)));
    await context.sync();
  });
}

export async function replaceSelection(text: string): Promise<void> {
  await Word.run(async (context) => {
    startTracking(context);
    const selection = context.document.getSelection();
    selection.load("text");
    await context.sync();
    if (!(selection.text || "").trim()) {
      throw new Error("選択範囲が空です。置き換える範囲を選んでから指示してください。");
    }
    selection.insertText(text, Word.InsertLocation.replace);
    await context.sync();
  });
}

export async function replaceQuote(quote: string, text: string): Promise<void> {
  await Word.run(async (context) => {
    startTracking(context);
    const target = await resolveTarget(context, quote);
    target.insertText(text, Word.InsertLocation.replace);
    await context.sync();
  });
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

function styleParagraph(paragraph: Word.Paragraph, spec: ParagraphSpec): void {
  paragraph.alignment = alignmentOf(spec);
  paragraph.font.name = spec.fontName;
  paragraph.font.nameFarEast = spec.fontName;
  paragraph.font.size = spec.fontSize;
  paragraph.font.bold = spec.bold;
  paragraph.firstLineIndent = spec.firstLineIndentPt;
  paragraph.leftIndent = spec.leftIndentPt;
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
  quote: string
): Promise<{ paragraph: Word.Paragraph; placement: InsertPlacement }> {
  if (quote.trim()) {
    const target = await resolveTarget(context, quote);
    return { paragraph: target.paragraphs.getFirst(), placement: "quote" };
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
export async function insertDraftParagraphs(
  specs: ParagraphSpec[],
  at: InsertAtArg = "cursor",
  quote = ""
): Promise<InsertLanding> {
  if (!specs.length) {
    return { placement: quote ? "quote" : at, after: "" };
  }

  let landing: InsertLanding = { placement: quote ? "quote" : at, after: "" };
  await Word.run(async (context) => {
    startTracking(context);
    const resolved = await resolveInsertStart(context, at, quote);
    resolved.paragraph.load("text");
    await context.sync();
    landing = { placement: resolved.placement, after: resolved.paragraph.text || "" };
    let current: Word.Paragraph = resolved.paragraph;
    const created: { paragraph: Word.Paragraph; spec: ParagraphSpec }[] = [];

    for (const spec of specs) {
      const text = specPlainText(spec) || "";
      const paragraph = current.insertParagraph(text, Word.InsertLocation.after);
      styleParagraph(paragraph, spec);
      created.push({ paragraph, spec });
      current = paragraph;
    }

    await context.sync();

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
  });
  return landing;
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

export async function formatText(args: FormatTextArgs): Promise<void> {
  await Word.run(async (context) => {
    startTracking(context);
    const target = await resolveTarget(context, args.quote);
    const font = target.font;
    if (args.bold !== undefined) {
      font.bold = args.bold;
    }
    if (args.italic !== undefined) {
      font.italic = args.italic;
    }
    if (args.underline !== undefined) {
      font.underline = args.underline ? Word.UnderlineType.single : Word.UnderlineType.none;
    }
    if (args.size !== undefined) {
      font.size = args.size;
    }
    if (args.fontName !== undefined) {
      font.name = args.fontName;
      font.nameFarEast = args.fontName;
    }
    if (args.color !== undefined) {
      font.color = args.color;
    }
    if (args.highlightColor !== undefined) {
      font.highlightColor = args.highlightColor.trim() ? args.highlightColor : null;
    }
    await context.sync();
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

export async function formatParagraph(args: FormatParagraphArgs): Promise<void> {
  await Word.run(async (context) => {
    startTracking(context);
    const target = await resolveTarget(context, args.quote);
    const paragraphs = target.paragraphs;
    paragraphs.load("items");
    await context.sync();

    if (!paragraphs.items.length) {
      throw new Error("対象の段落が見つかりませんでした。");
    }

    for (const paragraph of paragraphs.items) {
      if (args.alignment !== undefined) {
        paragraph.alignment = wordAlignment(args.alignment);
      }
      if (args.firstLineIndent !== undefined) {
        paragraph.firstLineIndent = args.firstLineIndent;
      }
      if (args.leftIndent !== undefined) {
        paragraph.leftIndent = args.leftIndent;
      }
      if (args.spaceAfter !== undefined) {
        paragraph.spaceAfter = args.spaceAfter;
      }
      if (args.lineSpacing !== undefined) {
        paragraph.lineSpacing = args.lineSpacing;
      }
    }
    await context.sync();
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
    selection.insertParagraph(formatCitation(hit), Word.InsertLocation.after);
    await context.sync();
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

/** Word のファイル URL。未保存なら空。 */
export function getDocumentPath(): string {
  try {
    return (Office.context.document.url || "").trim();
  } catch {
    return "";
  }
}
