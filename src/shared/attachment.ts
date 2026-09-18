import {
  ATTACHMENT_BUDGET_RATIO,
  CHARS_PER_TOKEN,
  MARKUP_BUDGET_RATIO,
  MAX_ATTACHMENT_CHARS,
} from "./constants";

/** What rides along with the instruction. The user picks this per turn. */
export type AttachmentScope = "document" | "selection" | "none";

/** A Word comment, flattened to what the model can act on. */
export type CommentNote = {
  author: string;
  /** YYYY-MM-DD, or empty when Word gave no date. */
  date: string;
  resolved: boolean;
  /** The text the comment is anchored to. */
  anchor: string;
  content: string;
  replies: { author: string; date: string; content: string }[];
};

export type ChangeKind = "insert" | "delete" | "format" | "other";

/** One tracked change: what was proposed, by whom, and where it sits. */
export type ChangeNote = {
  kind: ChangeKind;
  author: string;
  date: string;
  /** The inserted, deleted or reformatted text. */
  text: string;
  /** The paragraph the change sits in, which places a deletion the body no longer shows. */
  where: string;
};

/**
 * Comments and tracked changes are read separately from the body: each can fail
 * on its own, and an empty list means something different from a failed read.
 */
export type MarkupList<T> = {
  items: T[];
  /** Set when only the first few were read. */
  truncated: boolean;
  /** Why the list is empty, when Word would not give it. */
  error: string;
};

export type Attachment = {
  scope: AttachmentScope;
  /** Whole body, paragraph per line. Empty unless the scope asks for it. */
  document: string;
  /** Paragraphs behind `document`, for the composer readout. */
  paragraphs: number;
  /** Set when the budget cut the body short. */
  truncated: boolean;
  /** The current selection, sent as the place to look first. */
  focus: string;
  /** Whether the user asked for comments and tracked changes this turn. */
  markup: boolean;
  comments: MarkupList<CommentNote>;
  changes: MarkupList<ChangeNote>;
};

export function emptyMarkup<T>(): MarkupList<T> {
  return { items: [], truncated: false, error: "" };
}

/**
 * How much of each field a note keeps. A note is a pointer to a place in the
 * document, not a copy of it, so the caps are what makes a heavily marked-up
 * contract fit. Shared so a comment read from a `.docx` looks like one read
 * from the open document.
 */
export const MAX_ANCHOR_CHARS = 60;
export const MAX_COMMENT_BODY_CHARS = 400;
export const MAX_REPLY_CHARS = 200;
export const MAX_CHANGE_TEXT_CHARS = 200;
export const MAX_CHANGE_WHERE_CHARS = 80;

/** One line, so a note stays one line in the rendered section. */
export function clipNote(text: string, max: number): string {
  const flat = (text || "")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll("\u0007", "")
    .replaceAll("\u000b", " ")
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

export const EMPTY_ATTACHMENT: Attachment = {
  scope: "none",
  document: "",
  paragraphs: 0,
  truncated: false,
  focus: "",
  markup: false,
  comments: emptyMarkup(),
  changes: emptyMarkup(),
};

/**
 * How many characters of document may ride along. Derived from the window the
 * user set, so a narrow window does not silently blow the request.
 */
export function attachmentCharBudget(contextLimit: number): number {
  if (!Number.isFinite(contextLimit) || contextLimit <= 0) {
    return 0;
  }
  const fromLimit = Math.floor(contextLimit * ATTACHMENT_BUDGET_RATIO * CHARS_PER_TOKEN);
  return Math.max(0, Math.min(MAX_ATTACHMENT_CHARS, fromLimit));
}

/**
 * Comments and changes get their own slice. A heavily marked-up contract has
 * hundreds of them, and reading the body is no use if the markup is what the
 * user asked about.
 */
export function markupCharBudget(attachmentBudget: number): number {
  return Math.max(0, Math.floor(attachmentBudget * MARKUP_BUDGET_RATIO));
}

export function commentChars(note: CommentNote): number {
  const replies = note.replies.reduce(
    (total, reply) => total + reply.author.length + reply.date.length + reply.content.length,
    0
  );
  return note.author.length + note.date.length + note.anchor.length + note.content.length + replies;
}

export function changeChars(note: ChangeNote): number {
  return note.author.length + note.date.length + note.text.length + note.where.length;
}

export type AttachmentSummary = {
  scope: AttachmentScope;
  /** Body characters that will ride along, already clamped to the budget. */
  documentChars: number;
  /** Selection characters that will ride along. */
  focusChars: number;
  /** Paragraphs behind `documentChars`; left out of the text when not counted yet. */
  paragraphs?: number;
  truncated?: boolean;
  /** Comments and tracked changes, when the user asked for them. */
  markup?: boolean;
  comments?: number;
  changes?: number;
  /** Set when this Word cannot read tracked changes at all. */
  changesUnavailable?: boolean;
};

/** The line above the composer, so the cost of the turn is visible before sending. */
export function describeAttachment(summary: AttachmentSummary): string {
  if (summary.scope === "none") {
    return "添付しません";
  }
  const parts: string[] = [];
  if (summary.documentChars > 0) {
    const count = summary.documentChars.toLocaleString("ja-JP");
    const paragraphs = summary.paragraphs
      ? `（${summary.paragraphs.toLocaleString("ja-JP")} 段落）`
      : "";
    parts.push(`文書全体 ${count} 字${paragraphs}`);
  }
  if (summary.focusChars > 0) {
    parts.push(`選択 ${summary.focusChars.toLocaleString("ja-JP")} 字`);
  }
  if (summary.markup) {
    if (summary.scope === "selection") {
      // The counts are read from the whole body, so naming them here would
      // promise more than a selection-scoped read delivers.
      parts.push("選択内のコメントと変更履歴");
    } else {
      if (summary.comments) {
        parts.push(`コメント ${summary.comments.toLocaleString("ja-JP")} 件`);
      }
      if (summary.changes) {
        parts.push(`変更履歴 ${summary.changes.toLocaleString("ja-JP")} 件`);
      }
    }
  }
  if (!parts.length) {
    return summary.scope === "selection" ? "選択がないので添付しません" : "文書が空です";
  }
  const cut = summary.truncated ? "（長いので途中まで）" : "";
  return `${parts.join("・")}を添付します${cut}`;
}
