/**
 * Word list numbers are not in `paragraph.text`. The attachment shows them in
 * lenticular brackets so the model can read them, and the quote path strips
 * them so `search` still matches the body.
 *
 * Bullets and numbered lists are both `isListItem`. Word's bullet `listString`
 * is often a Symbol-font private-use character (shown as ), which the model
 * cannot tell from a number. The wrapper therefore canonicalises bullets to `•`.
 */

/** Average extra characters of `〔1.〕` for the context meter. */
export const LIST_MARK_AVG_CHARS = 8;

const UNREADABLE = "番号あり";
const BULLET_SHOWN = "•";
const WRAPPED_MARK = /^〔([^〕]*)〕\s*/;
/** Word Symbol bullets land in the private-use area; the rest are common glyphs. */
const BULLET_GLYPH = /^[\uE000-\uF8FF•●○■□◆◇‣·∙\-–—*＊・]$/;

export type ListKind = "number" | "bullet";

export type ListMark = { isListItem: boolean; listString: string; kind?: ListKind };

export function isBulletMark(mark: ListMark): boolean {
  if (!mark.isListItem) {
    return false;
  }
  if (mark.kind === "bullet") {
    return true;
  }
  if (mark.kind === "number") {
    return false;
  }
  const glyph = mark.listString.trim();
  return Boolean(glyph) && BULLET_GLYPH.test(glyph);
}

export function isNumberMark(mark: ListMark): boolean {
  return mark.isListItem && !isBulletMark(mark);
}

export function wrapListMark(mark: ListMark): string {
  if (!mark.isListItem) {
    return "";
  }
  if (isBulletMark(mark)) {
    return `〔${BULLET_SHOWN}〕`;
  }
  // Keep a trailing ideographic space when it is part of the label (arabicFull).
  const shown = mark.listString.trim() ? mark.listString : UNREADABLE;
  return `〔${shown}〕`;
}

export function listMarkChars(mark: ListMark): number {
  return wrapListMark(mark).length;
}

export function formatAttachedLine(number: number, text: string, mark: ListMark): string {
  const prefix = wrapListMark(mark);
  return prefix ? `[${number}] ${prefix}${text}` : `[${number}] ${text}`;
}

export function formatSelectionLine(text: string, mark: ListMark): string {
  const prefix = wrapListMark(mark);
  return prefix ? `${prefix}${text}` : text;
}

/** Drop our wrapper. Used when the model copied the attached line. */
export function stripWrappedListMark(text: string): string {
  return text.replace(WRAPPED_MARK, "").trim();
}

/**
 * Drop the live list string the attachment remembered for this paragraph.
 * `1. 甲は` becomes `甲は` only when that paragraph's mark really is `1.`.
 */
export function stripKnownListString(text: string, listString: string): string {
  if (!listString.trim()) {
    return text.trim();
  }
  const trimmed = text.trimStart();
  if (trimmed.startsWith(listString)) {
    return trimmed.slice(listString.length).trim();
  }
  const mark = listString.trim();
  if (trimmed.startsWith(mark)) {
    return trimmed.slice(mark.length).trim();
  }
  if (BULLET_GLYPH.test(mark) && trimmed.startsWith(BULLET_SHOWN)) {
    return trimmed.slice(BULLET_SHOWN.length).trim();
  }
  return trimmed.trim();
}

export function stripListMarks(quote: string, listString?: string): string {
  let out = stripWrappedListMark(quote);
  if (listString !== undefined) {
    out = stripKnownListString(out, listString);
  }
  return out;
}
