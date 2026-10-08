/**
 * Choosing paragraphs and match spans without Word. The add-in applies the
 * result in one `sync` instead of a tool round per paragraph.
 */

export type ListFilter = "any" | "bullet" | "numbered" | "none";

/** Every set field must match. An empty select matches nothing. */
export type FormatSelect = {
  /** Style name Word shows, or a built-in name such as Heading1. */
  style?: string;
  /** Navigation level, 1 to 9. */
  outlineLevel?: number;
  /** Substring, or a regular expression when `regex` is set. */
  text?: string;
  regex?: boolean;
  /** Default is case-insensitive, matching Word search. */
  matchCase?: boolean;
  /** True: only empty paragraphs. False: only paragraphs with text. */
  empty?: boolean;
  list?: ListFilter;
  /** True: only table cells. False: only paragraphs outside tables. */
  tableCell?: boolean;
};

export type ParagraphFact = {
  text: string;
  style: string;
  styleBuiltIn: string;
  /** 1-9, 10 for body text, null when Word did not say. */
  outlineLevel: number | null;
  list: "none" | "bullet" | "numbered" | "unknown";
  inTable: boolean;
};

export type ReplaceQuery = {
  find: string;
  regex?: boolean;
  matchCase?: boolean;
  wholeWord?: boolean;
};

export type TextMatch = {
  start: number;
  end: number;
  /** The exact slice in the original paragraph. Word search uses this. */
  text: string;
  /** 0-based index of this exact slice among the same text in the paragraph. */
  occurrence: number;
};

export const MAX_REGEX_CHARS = 200;
/** One replace call. More than this is a pattern that should be narrowed. */
export const MAX_REPLACE_MATCHES = 2000;

const LIST_FILTERS: ListFilter[] = ["any", "bullet", "numbered", "none"];

export function isListFilter(value: unknown): value is ListFilter {
  return LIST_FILTERS.includes(value as ListFilter);
}

export function listFilterEnum(): ListFilter[] {
  return [...LIST_FILTERS];
}

/**
 * Why `query` cannot be searched. Null when it can.
 * `maxLiteral` is Word's search limit (a regex is applied per paragraph in JS).
 */
export function replacePatternError(query: ReplaceQuery, maxLiteral: number): string | null {
  if (!query.find) {
    return "find が空です。";
  }
  if (query.regex) {
    if (query.find.length > MAX_REGEX_CHARS) {
      return `正規表現は ${MAX_REGEX_CHARS} 字までです。`;
    }
    try {
      new RegExp(query.find, query.matchCase ? "gu" : "giu");
    } catch {
      return "正規表現が不正です。";
    }
    return null;
  }
  if (query.find.length > maxLiteral) {
    return `find は ${maxLiteral} 字までです。正規表現ではない検索は 1 段落を超えられません。`;
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWordChar(ch: string | undefined): boolean {
  return Boolean(ch) && /[\p{L}\p{N}_]/u.test(ch as string);
}

/**
 * A whole word ends where a letter or digit ends. Japanese text has no spaces,
 * so 「契約」inside「契約書」is not a whole word, and 「第1条」before「（」is.
 */
function isWholeWord(text: string, start: number, end: number, matched: string): boolean {
  if (![...matched].some((ch) => isWordChar(ch))) {
    return false;
  }
  const before = start > 0 ? text[start - 1] : undefined;
  const after = end < text.length ? text[end] : undefined;
  return !isWordChar(before) && !isWordChar(after);
}

function literalSpans(
  text: string,
  needle: string,
  matchCase: boolean
): { start: number; end: number }[] {
  if (!needle) {
    return [];
  }
  if (!matchCase) {
    const foldedText = text.toLocaleLowerCase();
    const foldedNeedle = needle.toLocaleLowerCase();
    if (foldedText.length === text.length && foldedNeedle.length === needle.length) {
      return literalSpans(foldedText, foldedNeedle, true).map((span) => ({
        start: span.start,
        end: span.start + needle.length,
      }));
    }
    return regexSpans(text, escapeRegExp(needle), false);
  }
  const spans: { start: number; end: number }[] = [];
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(needle, from);
    if (at < 0) {
      break;
    }
    spans.push({ start: at, end: at + needle.length });
    from = at + needle.length;
  }
  return spans;
}

function regexSpans(
  text: string,
  pattern: string,
  matchCase: boolean
): { start: number; end: number }[] {
  const expression = new RegExp(pattern, matchCase ? "gu" : "giu");
  const spans: { start: number; end: number }[] = [];
  let guard = 0;
  while (guard <= MAX_REPLACE_MATCHES) {
    const found = expression.exec(text);
    if (!found) {
      break;
    }
    if (!found[0]) {
      expression.lastIndex += 1;
      continue;
    }
    spans.push({ start: found.index, end: found.index + found[0].length });
    guard += 1;
  }
  return spans;
}

function occurrenceOf(text: string, start: number, matched: string): number {
  let count = 0;
  let from = 0;
  while (from <= start) {
    const at = text.indexOf(matched, from);
    if (at < 0 || at >= start) {
      break;
    }
    count += 1;
    from = at + matched.length;
  }
  return count;
}

/**
 * Matches inside one paragraph, in document order. An invalid pattern yields
 * an empty list; callers validate with `replacePatternError` first.
 */
export function planTextMatches(text: string, query: ReplaceQuery): TextMatch[] {
  if (!query.find || !text) {
    return [];
  }
  let spans: { start: number; end: number }[];
  try {
    spans = query.regex
      ? regexSpans(text, query.find, query.matchCase === true)
      : literalSpans(text, query.find, query.matchCase === true);
  } catch {
    return [];
  }
  const matches: TextMatch[] = [];
  for (const span of spans) {
    const slice = text.slice(span.start, span.end);
    if (query.wholeWord && !isWholeWord(text, span.start, span.end, slice)) {
      continue;
    }
    matches.push({
      start: span.start,
      end: span.end,
      text: slice,
      occurrence: occurrenceOf(text, span.start, slice),
    });
    if (matches.length > MAX_REPLACE_MATCHES) {
      break;
    }
  }
  return matches;
}

export function countTextMatches(texts: string[], query: ReplaceQuery): number | { error: string } {
  let total = 0;
  for (const text of texts) {
    total += planTextMatches(text, query).length;
    if (total > MAX_REPLACE_MATCHES) {
      return {
        error: `一致が ${MAX_REPLACE_MATCHES} 件を超えています。検索を絞ってください。`,
      };
    }
  }
  return total;
}

function sameName(actual: string, wanted: string): boolean {
  if (!actual || !wanted) {
    return false;
  }
  return actual === wanted || actual.toLocaleLowerCase() === wanted.toLocaleLowerCase();
}

function textHits(fact: ParagraphFact, select: FormatSelect, pattern: RegExp | null): boolean {
  if (select.text === undefined) {
    return true;
  }
  if (select.regex) {
    if (!pattern) {
      return false;
    }
    pattern.lastIndex = 0;
    return pattern.test(fact.text);
  }
  return (
    planTextMatches(fact.text, {
      find: select.text,
      matchCase: select.matchCase,
    }).length > 0
  );
}

/** A select with no fields matches nothing, so a bare call cannot restyle the file. */
export function compileParagraphMatcher(select: FormatSelect): (fact: ParagraphFact) => boolean {
  const active =
    select.style !== undefined ||
    select.outlineLevel !== undefined ||
    select.text !== undefined ||
    select.empty !== undefined ||
    select.list !== undefined ||
    select.tableCell !== undefined;
  let pattern: RegExp | null = null;
  if (select.text && select.regex) {
    try {
      pattern = new RegExp(select.text, select.matchCase ? "u" : "iu");
    } catch {
      pattern = null;
    }
  }
  return (fact) => {
    if (!active) {
      return false;
    }
    if (
      select.style !== undefined &&
      !sameName(fact.style, select.style) &&
      !sameName(fact.styleBuiltIn, select.style)
    ) {
      return false;
    }
    if (select.outlineLevel !== undefined && fact.outlineLevel !== select.outlineLevel) {
      return false;
    }
    if (select.empty === true && fact.text.trim()) {
      return false;
    }
    if (select.empty === false && !fact.text.trim()) {
      return false;
    }
    if (!textHits(fact, select, pattern)) {
      return false;
    }
    if (select.list === "none" && fact.list !== "none") {
      return false;
    }
    if (select.list === "any" && fact.list === "none") {
      return false;
    }
    if (select.list === "bullet" && fact.list !== "bullet") {
      return false;
    }
    if (select.list === "numbered" && fact.list !== "numbered") {
      return false;
    }
    if (select.tableCell === true && !fact.inTable) {
      return false;
    }
    if (select.tableCell === false && fact.inTable) {
      return false;
    }
    return true;
  };
}
