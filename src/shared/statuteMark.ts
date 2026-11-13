/**
 * Marks statute citations the chat did not fetch with law_article.
 * Port of Argos `statute/cite.rs`. The button does not use this; it checks
 * the document in the sidecar.
 */

export const TOOL_RESULT_OMITTED = "（文脈の上限に達したため、この結果は省略しました）";
export const TOOL_RESULT_TRUNCATION_NOTE = "…（長いので省略しました）";

const DENY_LAW_NAME = [
  "方法",
  "手法",
  "療法",
  "用法",
  "違法",
  "適法",
  "合法",
  "魔法",
  "司法",
  "立法",
  "憲法改正",
];

export type VerifiedCite = { names: string[]; key: string };

type ArticleSpan = {
  start: number;
  end: number;
  key: string;
  display: string;
  suppl: boolean;
};

export function verifiedFromToolOutput(content: string): VerifiedCite[] {
  const out: VerifiedCite[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith("確認済み: ")) {
      continue;
    }
    const rest = line.slice("確認済み: ".length);
    const cut = rest.lastIndexOf(" ");
    if (cut <= 0) {
      continue;
    }
    const names = rest
      .slice(0, cut)
      .split("|")
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    const article = rest.slice(cut + 1);
    const parsed = parseArticleQuery(article);
    if (!parsed || names.length === 0) {
      continue;
    }
    out.push({ names, key: parsed.key });
  }
  return out;
}

export function verifiedFromDelivered(content: string): VerifiedCite[] {
  if (content.includes(TOOL_RESULT_OMITTED)) {
    return [];
  }
  const header = verifiedFromToolOutput(content);
  const cut = content.indexOf(TOOL_RESULT_TRUNCATION_NOTE);
  if (cut < 0) {
    return header;
  }
  const complete = completeSections(content, cut);
  return header.filter((cite) =>
    complete.some((section) => section.key === cite.key && cite.names.includes(section.name))
  );
}

export function markUnverified(answer: string, verified: VerifiedCite[]): string {
  const chars = Array.from(answer);
  const spans = articleSpans(answer);
  const inserts: number[] = [];
  let currentLaw: string | null = null;
  let currentSuppl = false;
  let previousEnd = 0;
  for (const span of spans) {
    if (span.start > chars.length || span.end > chars.length || span.start > span.end) {
      continue;
    }
    const prev = Math.min(previousEnd, span.start);
    const between = chars.slice(prev, span.start).join("");
    const mentioned = latestLawMention(between);
    if (mentioned) {
      currentLaw = mentioned;
    }
    const inherit =
      currentLaw !== null &&
      (isConnector(between) || between.trim() === "同法" || between.endsWith("同法"));
    const window = lawWindow(chars, span.start);
    const dou = window === "同法";
    let name: string | null;
    if (dou && currentLaw === null) {
      const laws = new Set(
        verified.filter((item) => item.key === span.key).map((item) => item.names[0] || "")
      );
      laws.delete("");
      name = laws.size === 1 ? [...laws][0] : null;
    } else if (inherit || dou) {
      name = currentLaw;
    } else if (window) {
      if (deniedToken(window)) {
        currentLaw = null;
        previousEnd = span.end;
        if (span.suppl && !alreadyMarked(chars, span.end)) {
          inserts.push(span.end);
        }
        continue;
      }
      const found = longestVerifiedSuffix(window, verified);
      if (found) {
        currentLaw = found;
        currentSuppl = span.suppl;
        name = found;
      } else if (window.endsWith("憲法") || window.endsWith("法") || window.endsWith("令") || window.endsWith("規則")) {
        currentLaw = window;
        currentSuppl = span.suppl;
        name = window;
      } else {
        currentLaw = null;
        previousEnd = span.end;
        if (span.suppl && !alreadyMarked(chars, span.end)) {
          inserts.push(span.end);
        }
        continue;
      }
    } else {
      currentLaw = null;
      previousEnd = span.end;
      if (span.suppl && !alreadyMarked(chars, span.end)) {
        inserts.push(span.end);
      }
      continue;
    }
    if (!name) {
      previousEnd = span.end;
      if ((span.suppl || dou) && !alreadyMarked(chars, span.end)) {
        inserts.push(span.end);
      }
      continue;
    }
    if (deniedToken(name)) {
      previousEnd = span.end;
      continue;
    }
    const suppl = span.suppl || ((inherit || dou) && currentSuppl);
    currentSuppl = suppl;
    if (!inherit && !dou) {
      currentLaw = name;
    }
    const ok =
      !suppl &&
      verified.some((item) => item.key === span.key && item.names.some((candidate) => candidate === name));
    if (!ok && !alreadyMarked(chars, span.end)) {
      inserts.push(span.end);
    }
    previousEnd = span.end;
  }
  if (inserts.length === 0) {
    return answer;
  }
  inserts.sort((a, b) => a - b);
  const unique = inserts.filter((end, index) => inserts.indexOf(end) === index);
  let out = "";
  let at = 0;
  for (const end of unique) {
    const bounded = Math.min(end, chars.length);
    if (bounded < at) {
      continue;
    }
    out += chars.slice(at, bounded).join("");
    out += "（要確認）";
    at = bounded;
  }
  out += chars.slice(at).join("");
  return out;
}

export type DeliveredTool = { name: string; content: string };

/** Marks only from law_article text the model actually received. */
export function markDelivered(answer: string, tools: DeliveredTool[]): string {
  const verified = tools
    .filter((tool) => tool.name === "law_article")
    .flatMap((tool) => verifiedFromDelivered(tool.content));
  return markUnverified(answer, verified);
}

/** @deprecated Use markDelivered so other tools cannot look like a statute fetch. */
export function markAnswer(answer: string, toolResults: string[]): string {
  return markDelivered(
    answer,
    toolResults.map((content) => ({ name: "law_article", content }))
  );
}

function deniedToken(window: string): boolean {
  const name = window.startsWith("改正")
    ? window.slice(2)
    : window.startsWith("現行")
      ? window.slice(2)
      : window;
  return DENY_LAW_NAME.some((deny) => deny === name || deny === window);
}

function prefixOk(before: string): boolean {
  if (!before || before.endsWith("旧") || before.endsWith("改正前")) {
    return !before;
  }
  if (before.endsWith("改正") || before.endsWith("現行") || before.endsWith("新")) {
    const rest = before.replace(/(改正|現行|新)$/u, "");
    return rest.length === 0 || /[。、，・（）「」\sはをにがとのやもへでか]/u.test(rest.slice(-1));
  }
  return /[。、，・（）「」\sはをにがとのやもへでか]/u.test(before.slice(-1));
}

function boundedSuffix(window: string, name: string): boolean {
  if (name.length < 2 || (window !== name && !window.endsWith(name))) {
    return false;
  }
  return prefixOk(window.slice(0, window.length - name.length));
}

function latestLawMention(gap: string): string | null {
  const re = /[〃々一-龯ぁ-んァ-ンー]{1,80}(?:法|令|規則)/g;
  let best: { end: number; name: string } | null = null;
  for (const match of gap.matchAll(re)) {
    const name = match[0];
    if (name === "同法" || deniedToken(name)) {
      continue;
    }
    const before = gap.slice(0, match.index ?? 0);
    if (!prefixOk(before)) {
      continue;
    }
    const end = (match.index ?? 0) + name.length;
    if (!best || end >= best.end) {
      best = { end, name };
    }
  }
  return best?.name ?? null;
}

function longestVerifiedSuffix(window: string, verified: VerifiedCite[]): string | null {
  let best: string | null = null;
  for (const item of verified) {
    for (const name of item.names) {
      if (!boundedSuffix(window, name)) {
        continue;
      }
      if (!best || Array.from(name).length > Array.from(best).length) {
        best = name;
      }
    }
  }
  return best;
}

function lawWindow(chars: string[], citeStart: number): string | null {
  let end = citeStart;
  while (end > 0 && /\s/u.test(chars[end - 1])) {
    end -= 1;
  }
  const tail = chars.slice(Math.max(0, end - 6), end).join("");
  if (["若しくは", "並びに", "および", "又は", "または", "及び", "、", "，", "・", "と", "か"].some((c) => tail.endsWith(c))) {
    return null;
  }
  let start = end;
  while (start > 0 && isLawChar(chars[start - 1])) {
    start -= 1;
  }
  if (start === end) {
    return null;
  }
  const name = chars.slice(start, end).join("");
  return Array.from(name).length < 2 ? null : name;
}

function isLawChar(c: string): boolean {
  return /[\u3400-\u9fff\u3040-\u30ff々、，]/u.test(c);
}

function isConnector(between: string): boolean {
  const text = Array.from(between)
    .filter((c) => !/\s/u.test(c))
    .join("");
  return ["及び", "および", "又は", "または", "若しくは", "並びに", "と", "、", "，", "・"].includes(text);
}

function alreadyMarked(chars: string[], end: number): boolean {
  let i = end;
  while (i < chars.length && /\s/u.test(chars[i])) {
    i += 1;
  }
  const rest = chars.slice(i, i + 8).join("");
  return rest.startsWith("（要確認）") || rest.startsWith("要確認");
}

function completeSections(content: string, cut: number): { name: string; key: string }[] {
  const chars = Array.from(content);
  // `cut` is the UTF-16 index of the truncation note, which matches a code
  // point index for the BMP text these citations use.
  const cutChars = cut;
  const starts: number[] = [];
  chars.forEach((ch, i) => {
    if (ch === "【") {
      starts.push(i);
    }
  });
  const sections: { name: string; key: string }[] = [];
  starts.forEach((start, idx) => {
    const end = starts[idx + 1] ?? chars.length;
    if (cutChars < end) {
      return;
    }
    const heading = chars.slice(start, end).join("").split("】")[0] ?? "";
    const span = articleSpans(heading)[0];
    if (!span || span.start > Array.from(heading).length) {
      return;
    }
    const name = Array.from(heading).slice(0, span.start).join("").replace(/^【/, "").trim();
    if (!name) {
      return;
    }
    sections.push({ name, key: span.key });
  });
  return sections;
}

function articleSpans(text: string): ArticleSpan[] {
  const chars = Array.from(text);
  const out: ArticleSpan[] = [];
  let i = 0;
  while (i < chars.length) {
    const span = citationAt(chars, i);
    if (!span) {
      i += 1;
      continue;
    }
    out.push(span);
    i = Math.max(span.end, i + 1);
  }
  return out;
}

function parseArticleQuery(raw: string): { key: string; display: string } | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }
  if (
    !text.includes("第") &&
    !text.includes("条") &&
    !text.includes("附") &&
    Array.from(text).every((c) => isAsciiDigit(c) || isFullwidthDigit(c) || c === "_")
  ) {
    const ascii = Array.from(text)
      .map((c) => (isFullwidthDigit(c) ? String.fromCharCode(c.charCodeAt(0) - 0xfee0) : c))
      .join("");
    return articleIdentity(ascii, false);
  }
  const span = articleSpans(text)[0];
  if (span) {
    return { key: span.key, display: span.display };
  }
  if (text.includes("条")) {
    return null;
  }
  const rewritten = articleSpans(ensureArticleMark(text))[0];
  return rewritten ? { key: rewritten.key, display: rewritten.display } : null;
}

function citationAt(chars: string[], i: number): ArticleSpan | null {
  const withDai = chars[i] === "第";
  const digitStart = isAsciiDigit(chars[i] || "") || isFullwidthDigit(chars[i] || "");
  if (!withDai && !digitStart) {
    return null;
  }
  if (!withDai && i > 0 && (chars[i - 1] === "第" || isNumeralChar(chars[i - 1]))) {
    return null;
  }
  const numStart = withDai ? i + 1 : i;
  const main = takeNumeral(chars, numStart);
  if (!main) {
    return null;
  }
  const parts = [main.value];
  let end = main.end;
  if (chars[end] === "条") {
    end += 1;
    end = takeBranches(chars, end, parts);
  } else if (withDai && chars[end] === "の") {
    end = takeBranches(chars, end, parts);
    if (parts.length < 2) {
      return null;
    }
  } else {
    return null;
  }
  const supplAt = supplPrefix(chars, i);
  const suppl = supplAt !== null;
  const start = supplAt ?? i;
  if (start > end || end > chars.length) {
    return null;
  }
  const ident = articleIdentity(parts.join("_"), suppl);
  if (!ident) {
    return null;
  }
  return { start, end, key: ident.key, display: ident.display, suppl };
}

function takeBranches(chars: string[], end: number, parts: number[]): number {
  let cursor = end;
  while (chars[cursor] === "の") {
    const branch = takeNumeral(chars, cursor + 1);
    if (!branch) {
      break;
    }
    if (chars[branch.end] === "条") {
      break;
    }
    parts.push(branch.value);
    cursor = branch.end;
  }
  return cursor;
}

function ensureArticleMark(text: string): string {
  const chars = Array.from(text);
  let out = text.includes("第") ? "" : "第";
  let inserted = false;
  for (const c of chars) {
    if (!inserted && c === "の") {
      out += "条";
      inserted = true;
    }
    out += c;
  }
  if (!inserted) {
    out += "条";
  }
  return out;
}

function takeNumeral(chars: string[], start: number): { value: number; end: number } | null {
  let end = start;
  while (end < chars.length && isNumeralChar(chars[end])) {
    end += 1;
  }
  while (end > start) {
    const token = chars.slice(start, end).join("");
    const n = parseLegalNumeral(token);
    if (n !== null && n > 0 && n <= 999_999) {
      return { value: n, end };
    }
    end -= 1;
  }
  return null;
}

function supplPrefix(chars: string[], articleAt: number): number | null {
  let i = skipWsBack(chars, articleAt);
  for (let n = 0; n < 2; n += 1) {
    if (i > 0 && chars[i - 1] === "の") {
      i = skipWsBack(chars, i - 1);
      continue;
    }
    const next = skipParensBack(chars, i);
    if (next !== null) {
      i = skipWsBack(chars, next);
      continue;
    }
    break;
  }
  return supplWord(chars, i);
}

function skipWsBack(chars: string[], i: number): number {
  while (i > 0 && /\s/u.test(chars[i - 1])) {
    i -= 1;
  }
  return i;
}

function skipParensBack(chars: string[], i: number): number | null {
  if (i === 0) {
    return null;
  }
  const open = chars[i - 1] === "）" ? "（" : chars[i - 1] === ")" ? "(" : "";
  if (!open) {
    return null;
  }
  let j = i - 1;
  while (j > 0 && chars[j - 1] !== open) {
    j -= 1;
  }
  if (j === 0 || chars[j - 1] !== open) {
    return null;
  }
  return j - 1;
}

function supplWord(chars: string[], i: number): number | null {
  if (i >= 2 && chars[i - 2] === "附" && chars[i - 1] === "則") {
    return i - 2;
  }
  if (i >= 3 && chars[i - 3] === "附" && chars[i - 1] === "則" && /\s/u.test(chars[i - 2])) {
    return i - 3;
  }
  return null;
}

function articleIdentity(num: string, suppl: boolean): { key: string; display: string } | null {
  const parts: number[] = [];
  for (const part of num.trim().split("_")) {
    if (!part) {
      return null;
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n <= 0 || n > 999_999) {
      return null;
    }
    parts.push(n);
  }
  if (parts.length === 0) {
    return null;
  }
  const keyBody = parts.join("_");
  const key = suppl ? `s${keyBody}` : keyBody;
  let display = suppl ? "附則" : "";
  display += `第${parts[0]}条`;
  for (const branch of parts.slice(1)) {
    display += `の${branch}`;
  }
  return { key, display };
}

function isAsciiDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isFullwidthDigit(c: string): boolean {
  return c >= "０" && c <= "９";
}

function isNumeralChar(c: string): boolean {
  return (
    isAsciiDigit(c) ||
    isFullwidthDigit(c) ||
    "〇零一二三四五六七八九十百千万".includes(c)
  );
}

function parseLegalNumeral(text: string): number | null {
  const s = text.trim();
  if (!s) {
    return null;
  }
  const arabic = parseArabic(s);
  if (arabic !== null) {
    return arabic;
  }
  if (!Array.from(s).some((c) => "十百千万".includes(c))) {
    return parseDigitRun(s);
  }
  return parsePlaceValue(s);
}

function parseArabic(s: string): number | null {
  if (!Array.from(s).every((c) => isAsciiDigit(c) || isFullwidthDigit(c))) {
    return null;
  }
  const t = Array.from(s)
    .map((c) => (isFullwidthDigit(c) ? String.fromCharCode(c.charCodeAt(0) - 0xfee0) : c))
    .join("");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function kanjiDigit(c: string): number | null {
  const map: Record<string, number> = {
    〇: 0,
    零: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  return c in map ? map[c] : null;
}

function parseDigitRun(s: string): number | null {
  let n = 0;
  let digits = 0;
  for (const c of Array.from(s)) {
    const d = kanjiDigit(c);
    if (d === null) {
      return null;
    }
    n = n * 10 + d;
    digits += 1;
    if (digits > 8) {
      return null;
    }
  }
  return digits === 0 ? null : n;
}

function parsePlaceValue(s: string): number | null {
  let result = 0;
  let current = 0;
  for (const c of Array.from(s)) {
    const d = kanjiDigit(c);
    if (d !== null) {
      current = d;
      continue;
    }
    if (c === "万") {
      const head = result + current;
      result = Math.max(head, 1) * 10_000;
      current = 0;
      continue;
    }
    const place = c === "十" ? 10 : c === "百" ? 100 : c === "千" ? 1000 : 0;
    if (!place) {
      return null;
    }
    result += Math.max(current, 1) * place;
    current = 0;
  }
  return result + current;
}
