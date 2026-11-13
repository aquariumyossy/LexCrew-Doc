/**
 * Marks statute citations the chat did not fetch with law_article.
 * Law names come from the same catalog the Rust checker uses.
 */
import catalog from "./lawCatalog.json";

export const TOOL_RESULT_OMITTED = "（文脈の上限に達したため、この結果は省略しました）";
export const TOOL_RESULT_TRUNCATION_NOTE = "…（長いので省略しました）";

const DENY_LAW_NAME = catalog.deny;

type CatalogAlias = { alias: string; id: string; canonical: string };

const CATALOG_ALIASES: CatalogAlias[] = catalog.laws
  .flatMap((law) =>
    law.aliases.map((alias) => ({
      alias,
      id: law.id,
      canonical: law.aliases[0],
    }))
  )
  .sort((a, b) => Array.from(b.alias).length - Array.from(a.alias).length);

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

type EnumFrame = {
  prevEnd: number;
  openAt: number | null;
  law: string | null;
  douhou: string | null;
  openedWith: string | null;
  named: boolean;
  sawOther: boolean;
  ambiguous: boolean;
  closeAt: number | null;
  pending: { open: number; close: number; outerKey: string }[];
  suppl: boolean;
};

type OpenQuote = { outer: string | null; sawOther: boolean; marksInner: boolean; start: number };

export function markUnverified(answer: string, verified: VerifiedCite[]): string {
  const chars = Array.from(answer);
  const spans = articleSpans(answer);
  const inserts: number[] = [];
  const stack: EnumFrame[] = [
    {
      prevEnd: 0,
      openAt: null,
      law: null,
      douhou: null,
      openedWith: null,
      named: false,
      sawOther: false,
      ambiguous: false,
      closeAt: null,
      pending: [],
      suppl: false,
    },
  ];
  const quotes: OpenQuote[] = [];
  let seen = 0;
  let lastQuote: { at: number; open: boolean } | null = null;
  let accepted = 0;
  const remember = (frame: EnumFrame, name: string) => {
    const key = lawKey(name);
    if (frame.openedWith && key !== frame.openedWith) {
      frame.sawOther = true;
    }
    const quote = quotes[quotes.length - 1];
    if (quote?.outer && key !== quote.outer) {
      quote.sawOther = true;
    }
    frame.law = name;
    frame.douhou = name;
    frame.named = true;
    frame.ambiguous = false;
    frame.pending = [];
  };
  for (const span of spans) {
    if (span.start > chars.length || span.end > chars.length || span.start > span.end) {
      continue;
    }
    while (seen < span.start && seen < chars.length) {
      const c = chars[seen];
      if (c === "\u2029" || (c === "\n" && seen > 0 && chars[seen - 1] === "\n")) {
        while (quotes.length > 0) {
          const quote = quotes.pop();
          const frame = stack[stack.length - 1];
          if (quote && frame) {
            if (quote.sawOther) {
              frame.ambiguous = true;
            } else if (quote.outer && !frame.ambiguous) {
              queueNote(frame, chars, quote.start, seen, quote.outer);
            }
          }
        }
      }
      if (c === "「") {
        const frame = stack[stack.length - 1];
        quotes.push({
          outer: frame?.law ? lawKey(frame.law) : null,
          sawOther: false,
          marksInner: Boolean(frame?.law),
          start: seen,
        });
        lastQuote = { at: seen, open: true };
      } else if (c === "」") {
        const quote = quotes.pop();
        const frame = stack[stack.length - 1];
        if (quote && frame) {
          if (quote.sawOther) {
            frame.ambiguous = true;
          } else if (quote.outer && !frame.ambiguous) {
            queueNote(frame, chars, quote.start, seen, quote.outer);
          }
        }
        lastQuote = { at: seen, open: false };
      } else if (quotes.length === 0 && isLineBreak(c)) {
        while (stack.length > 1) {
          const closesLater = (stack[stack.length - 1]?.closeAt ?? -1) > seen;
          if (closesLater) {
            break;
          }
          absorbClosedFrame(stack);
        }
        if (stack.length === 1 && stack[0]) {
          stack[0].prevEnd = seen + 1;
        }
      } else if (quotes.length === 0 && (c === "（" || c === "(")) {
        const outer = stack[stack.length - 1];
        stack.push({
          prevEnd: seen + 1,
          openAt: seen,
          law: null,
          douhou: outer?.douhou ?? null,
          openedWith: outer?.law ? lawKey(outer.law) : null,
          named: false,
          sawOther: false,
          ambiguous: outer?.ambiguous ?? false,
          closeAt: matchingClose(chars, seen, chars.length),
          pending: [],
          suppl: false,
        });
      } else if (quotes.length === 0 && (c === "）" || c === ")") && stack.length > 1) {
        const openAt = stack[stack.length - 1]?.openAt;
        const outerKey = stack[stack.length - 2]?.law ? lawKey(stack[stack.length - 2].law as string) : null;
        absorbClosedFrame(stack);
        const frame = stack[stack.length - 1];
        if (openAt != null && outerKey && frame && !frame.ambiguous) {
          queueNote(frame, chars, openAt, seen, outerKey);
        }
      }
      seen += 1;
    }
    const frame = stack[stack.length - 1];
    const prev = Math.min(frame.prevEnd, span.start);
    const between = chars.slice(prev, span.start).join("");
    const mentioned = latestLawMention(between);
    if (mentioned) {
      remember(frame, mentioned);
    }
    const acrossLine = frame.closeAt != null;
    const window = lawWindow(chars, span.start, prev, acrossLine);
    const dou = window === "同法";
    if (dou) {
      flushPending(frame, chars);
    }
    let enumerated = window === null && isEnumeration(between, acrossLine);
    if (enumerated && frame.openAt != null && frame.closeAt == null) {
      enumerated = false;
    }
    const inherited = dou || enumerated;
    if (dou && frame.ambiguous) {
      if (!alreadyMarked(chars, span.end)) {
        inserts.push(span.end);
      }
      frame.prevEnd = span.end;
      accepted += 1;
      continue;
    }
    const target = dou ? frame.douhou : frame.law;
    let name: string | null;
    if (!span.suppl && !dou && !enumerated && (window === null || !looksLikeLawName(window))) {
      continue;
    }
    if (dou && target === null) {
      const laws = new Set(
        verified.filter((item) => item.key === span.key).map((item) => item.names[0] || "")
      );
      laws.delete("");
      name = laws.size === 1 ? [...laws][0] : null;
    } else if (inherited) {
      name = target;
    } else if (window) {
      if (deniedToken(window)) {
        frame.law = null;
        frame.douhou = null;
        frame.named = false;
        if (span.suppl && !alreadyMarked(chars, span.end)) {
          inserts.push(span.end);
          frame.prevEnd = span.end;
        }
        continue;
      }
      const found = longestVerifiedSuffix(window, verified);
      if (found) {
        remember(frame, found);
        frame.suppl = span.suppl;
        name = found;
      } else if (looksLikeLawName(window)) {
        remember(frame, window);
        frame.suppl = span.suppl;
        name = window;
      } else {
        frame.law = null;
        frame.douhou = null;
        frame.named = false;
        if (span.suppl && !alreadyMarked(chars, span.end)) {
          inserts.push(span.end);
          frame.prevEnd = span.end;
        }
        continue;
      }
    } else {
      frame.law = null;
      frame.douhou = null;
      frame.named = false;
      if (span.suppl && !alreadyMarked(chars, span.end)) {
        inserts.push(span.end);
        frame.prevEnd = span.end;
      }
      continue;
    }
    const quoteOpen = quotes.some((quote) => quote.marksInner);
    accepted += 1;
    if (quoteOpen) {
      if (!alreadyMarked(chars, span.end)) {
        inserts.push(span.end);
      }
      frame.prevEnd = span.end;
      continue;
    }
    if (!name) {
      if ((span.suppl || dou) && !alreadyMarked(chars, span.end)) {
        inserts.push(span.end);
        frame.prevEnd = span.end;
      }
      continue;
    }
    if (deniedToken(name)) {
      frame.prevEnd = span.end;
      continue;
    }
    const suppl = span.suppl || (inherited && frame.suppl);
    frame.suppl = suppl;
    if (!inherited) {
      remember(frame, name);
    }
    const ok =
      !suppl &&
      verified.some((item) => item.key === span.key && item.names.some((candidate) => candidate === name));
    if (!ok && !alreadyMarked(chars, span.end)) {
      inserts.push(span.end);
    }
    frame.prevEnd = span.end;
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

const NAME_PARTICLES = [
  "によれば",
  "について",
  "ならびに",
  "による",
  "により",
  "として",
  "同じく",
  "では",
  "には",
  "とは",
  "前記",
  "上記",
  "から",
  "まで",
  "なお",
  "より",
];

const JOINERS = ["並びに", "ならびに", "および", "または", "及び", "又は"];

function prefixOk(before: string): boolean {
  if (!before) {
    return true;
  }
  if (before.endsWith("旧") || before.endsWith("改正前")) {
    return false;
  }
  if (before.endsWith("改正") || before.endsWith("現行") || before.endsWith("新")) {
    const rest = before.replace(/(改正|現行|新)$/u, "");
    return rest.length === 0 || /[。、，・（）「」\sはをにがとのやもへでか]/u.test(rest.slice(-1));
  }
  if (NAME_PARTICLES.some((particle) => before.endsWith(particle))) {
    return true;
  }
  if (JOINERS.some((conn) => before.endsWith(conn))) {
    return true;
  }
  return /[。、，・（）「」\sはをにがとのやもへでか]/u.test(before.slice(-1));
}

function resolveCatalog(window: string): CatalogAlias | null {
  let best: CatalogAlias | null = null;
  for (const hit of CATALOG_ALIASES) {
    if (Array.from(hit.alias).length < 2) {
      continue;
    }
    if (window !== hit.alias && !window.endsWith(hit.alias)) {
      continue;
    }
    const before = window.slice(0, window.length - hit.alias.length);
    if (!prefixOk(before)) {
      continue;
    }
    if (!best || Array.from(hit.alias).length > Array.from(best.alias).length) {
      best = hit;
    }
  }
  return best;
}

function lawNameAfterParticle(name: string): string {
  let best = 0;
  for (const particle of NAME_PARTICLES) {
    const idx = name.lastIndexOf(particle);
    if (idx < 0) {
      continue;
    }
    const cut = idx + particle.length;
    const rest = name.slice(cut);
    if (Array.from(rest).length < 2 || cut >= name.length || /[ぁ-ん]/u.test(rest)) {
      continue;
    }
    if (cut > best) {
      best = cut;
    }
  }
  return best > 0 ? name.slice(best) : name;
}

function boundedSuffix(window: string, name: string): boolean {
  if (name.length < 2 || (window !== name && !window.endsWith(name))) {
    return false;
  }
  return prefixOk(window.slice(0, window.length - name.length));
}

function latestLawMention(gap: string): string | null {
  const flat = blankInsideParens(gap);
  let best: { end: number; len: number; name: string } | null = null;
  for (const hit of CATALOG_ALIASES) {
    let from = 0;
    while (from < flat.length) {
      const pos = flat.indexOf(hit.alias, from);
      if (pos < 0) {
        break;
      }
      const before = flat.slice(0, pos);
      if (prefixOk(before)) {
        const end = pos + hit.alias.length;
        const len = Array.from(hit.alias).length;
        if (!best || end > best.end || (end === best.end && len > best.len)) {
          best = { end, len, name: hit.alias };
        }
      }
      from = pos + Math.max(hit.alias.length, 1);
    }
  }
  return best?.name ?? null;
}

function blankInsideParens(gap: string): string {
  const chars = Array.from(gap);
  let depth = 0;
  let quote = false;
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    if (c === "「") {
      quote = true;
    } else if (c === "」") {
      quote = false;
    } else if (!quote && (c === "（" || c === "(")) {
      depth += 1;
    } else if (!quote && (c === "）" || c === ")") && depth > 0) {
      depth -= 1;
    } else if (depth > 0 || quote) {
      chars[i] = " ";
    }
  }
  return chars.join("");
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

function isHardBoundary(c: string): boolean {
  return (
    c === "。" ||
    c === "！" ||
    c === "？" ||
    c === "!" ||
    c === "?" ||
    c === "\n" ||
    c === "\r" ||
    c === "\u000b" ||
    c === "\u2028" ||
    c === "\u2029"
  );
}

function isHspace(c: string): boolean {
  return c === " " || c === "\u3000" || c === "\t";
}

function lawWindow(chars: string[], citeStart: number, floor: number, acrossLine = false): string | null {
  const stop = Math.min(floor, citeStart);
  let end = citeStart;
  while (end > stop && (isHspace(chars[end - 1]) || (acrossLine && isLineBreak(chars[end - 1])))) {
    end -= 1;
  }
  if (end > stop && isHardBoundary(chars[end - 1])) {
    return null;
  }
  const peeledEnd = peelGlue(chars, end, stop);
  if (peeledEnd === null) {
    return null;
  }
  end = peeledEnd;
  const tail = chars.slice(Math.max(stop, end - 6), end).join("");
  if (["若しくは", "並びに", "および", "又は", "または", "及び", "、", "，", "・", "と", "か"].some((c) => tail.endsWith(c))) {
    return null;
  }
  let start = end;
  while (start > stop && isLawChar(chars[start - 1]) && !isHardBoundary(chars[start - 1])) {
    start -= 1;
  }
  if (start >= end) {
    return null;
  }
  let raw = chars.slice(start, end).join("");
  const lead = ["若しくは", "ならびに", "並びに", "あるいは", "および", "又は", "または", "及び", "、", "，", "・"].find((c) =>
    raw.startsWith(c)
  );
  if (lead) {
    raw = raw.slice(lead.length);
  }
  const name = lawNameAfterParticle(raw);
  if (Array.from(name).length < 2) {
    return null;
  }
  return resolveCatalog(name)?.alias ?? (looksLikeLawName(name) ? name : null);
}

function peelGlue(chars: string[], end: number, floor: number): number | null {
  let cursor = end;
  while (true) {
    while (cursor > floor && isHspace(chars[cursor - 1])) {
      cursor -= 1;
    }
    if (cursor === floor || isHardBoundary(chars[cursor - 1])) {
      break;
    }
    if (chars[cursor - 1] === "の") {
      cursor -= 1;
      continue;
    }
    if (chars[cursor - 1] === "）" || chars[cursor - 1] === ")") {
      const openAt = matchingOpenSameLine(chars, cursor - 1, floor);
      if (openAt === null) {
        return null;
      }
      const inner = chars.slice(openAt + 1, cursor - 1).join("");
      if (!isPromulgation(inner) && !isAbbreviationNote(inner) && !sameLawAlias(chars, openAt, floor, inner)) {
        return null;
      }
      cursor = openAt;
      continue;
    }
    break;
  }
  return cursor;
}

function matchingOpenSameLine(chars: string[], closeAt: number, floor: number): number | null {
  if (!isCloseParen(chars[closeAt] ?? "")) {
    return null;
  }
  let depth = 0;
  let i = closeAt;
  while (true) {
    const c = chars[i];
    if (isHardBoundary(c) && c !== "。" && c !== "！" && c !== "？" && c !== "!" && c !== "?") {
      return null;
    }
    if (isCloseParen(c)) {
      depth += 1;
    } else if (isOpenParen(c)) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
    if (i === floor) {
      return null;
    }
    i -= 1;
  }
}

function isPromulgation(inner: string): boolean {
  const kind = ["法律", "政令", "勅令", "府令", "省令", "規則", "条例"].some((name) => inner.includes(name));
  return inner.includes("年") && kind && inner.includes("第") && inner.includes("号");
}

function isAbbreviationNote(inner: string): boolean {
  return inner.includes("以下") && inner.includes("という");
}

function sameLawAlias(chars: string[], openAt: number, floor: number, inner: string): boolean {
  let start = openAt;
  while (start > floor && isLawChar(chars[start - 1]) && !isHardBoundary(chars[start - 1])) {
    start -= 1;
  }
  const preceding = lawNameAfterParticle(chars.slice(start, openAt).join(""));
  const outer = resolveCatalog(preceding);
  const innerLaw = resolveCatalog(inner.trim());
  return Boolean(outer && innerLaw && outer.id === innerLaw.id);
}

function lawKey(name: string): string {
  return resolveCatalog(name)?.id ?? name;
}

function looksLikeLawName(name: string): boolean {
  // 法律 ends in 律, not 法. Only a real title, or a catalog hit, counts.
  if (name.endsWith("法律")) {
    return name.endsWith("に関する法律");
  }
  return (
    name.endsWith("憲法") ||
    name.endsWith("法") ||
    name.endsWith("令") ||
    name.endsWith("規則") ||
    name.endsWith("条例")
  );
}

function isEnumeration(between: string, ignoreLineBreaks = false): boolean {
  const chars = Array.from(between);
  if (gapCrossesSentence(chars, ignoreLineBreaks)) {
    return false;
  }
  const text = gapCore(chars);
  return ["及び", "および", "並びに", "ならびに", "又は", "または", "若しくは", "、", "，", "・"].includes(text);
}

function gapCrossesSentence(chars: string[], ignoreLineBreaks = false): boolean {
  let depth = 0;
  let quote = false;
  for (const c of chars) {
    if (c === "「") {
      quote = true;
      continue;
    }
    if (c === "」") {
      quote = false;
      continue;
    }
    if (quote) {
      continue;
    }
    if (c === "（" || c === "(") {
      depth += 1;
      continue;
    }
    if ((c === "）" || c === ")") && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth === 0 && isHardBoundary(c)) {
      if (ignoreLineBreaks && isLineBreak(c)) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function gapCore(chars: string[]): string {
  let text = "";
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === "「") {
      let j = i + 1;
      while (j < chars.length && chars[j] !== "」") {
        j += 1;
      }
      if (j >= chars.length) {
        text += chars.slice(i).join("");
        break;
      }
      i = j + 1;
      continue;
    }
    if (chars[i] === "（" || chars[i] === "(") {
      const close = matchingClose(chars, i, chars.length);
      if (close !== null) {
        const inner = chars.slice(i + 1, close).join("");
        if (isListMarker(inner)) {
          text += chars[i] + inner + chars[close];
        }
        i = close + 1;
        continue;
      }
      text += chars[i];
      i += 1;
      continue;
    }
    if (chars[i] === "）" || chars[i] === ")") {
      i += 1;
      continue;
    }
    if (isCircled(chars[i])) {
      text += chars[i];
      i += 1;
      continue;
    }
    if (!/\s/u.test(chars[i])) {
      text += chars[i];
    }
    i += 1;
  }
  return text;
}

function isOpenParen(c: string): boolean {
  return c === "（" || c === "(";
}

function isCloseParen(c: string): boolean {
  return c === "）" || c === ")";
}

function matchingClose(chars: string[], openAt: number, limit: number): number | null {
  if (!isOpenParen(chars[openAt] ?? "")) {
    return null;
  }
  let depth = 0;
  for (let i = openAt; i < Math.min(limit, chars.length); i += 1) {
    if (isOpenParen(chars[i])) {
      depth += 1;
    } else if (isCloseParen(chars[i])) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return null;
}

function isLineBreak(c: string): boolean {
  return c === "\n" || c === "\r" || c === "\u000b" || c === "\u2028" || c === "\u2029";
}

function absorbClosedFrame(stack: EnumFrame[]): void {
  if (stack.length <= 1) {
    return;
  }
  const inner = stack.pop();
  const outer = stack[stack.length - 1];
  if (!inner || !outer) {
    return;
  }
  if (inner.sawOther) {
    outer.ambiguous = true;
    outer.sawOther = true;
  } else if (inner.named) {
    if (inner.douhou) {
      outer.douhou = inner.douhou;
    }
    if (outer.law == null && inner.law) {
      outer.law = inner.law;
    }
    outer.named = true;
    if (outer.openedWith && outer.law && lawKey(outer.law) !== outer.openedWith) {
      outer.sawOther = true;
    }
  }
}

function queueNote(
  frame: EnumFrame,
  chars: string[],
  open: number,
  close: number,
  outerKey: string
): void {
  if (close <= open + 1) {
    return;
  }
  const inner = chars.slice(open + 1, close).join("");
  if (isWholeNote(inner)) {
    return;
  }
  frame.pending.push({ open, close, outerKey });
}

function isWholeNote(inner: string): boolean {
  const trimmed = inner.trim().replace(/。+$/u, "").trim();
  if (trimmed.includes("（") || trimmed.includes("(")) {
    return false;
  }
  return isPromulgation(trimmed) || isAbbreviationNote(trimmed);
}

function stripNestedNotes(text: string): string {
  const chars = Array.from(text);
  let out = "";
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === "（" || chars[i] === "(") {
      const close = matchingClose(chars, i, chars.length);
      if (close !== null) {
        const inner = chars.slice(i + 1, close).join("").trim();
        if (isPromulgation(inner) || isAbbreviationNote(inner)) {
          i = close + 1;
          continue;
        }
      }
    }
    out += chars[i];
    i += 1;
  }
  return out;
}

function withoutDenied(text: string): string {
  let out = text;
  for (const deny of DENY_LAW_NAME) {
    if (out.includes(deny)) {
      out = out.split(deny).join(" ");
    }
  }
  return out;
}

function flushPending(frame: EnumFrame, chars: string[]): void {
  if (frame.ambiguous) {
    frame.pending = [];
    return;
  }
  const notes = frame.pending;
  frame.pending = [];
  for (const note of notes) {
    if (frame.ambiguous) {
      break;
    }
    const raw = chars.slice(note.open + 1, note.close).join("");
    const mentioned = latestLawMention(withoutDenied(stripNestedNotes(raw)));
    if (mentioned && lawKey(mentioned) !== note.outerKey) {
      frame.ambiguous = true;
    }
  }
}

function parenClosesInSentence(chars: string[], openAt: number): boolean {
  let depth = 0;
  let quote = false;
  for (let i = openAt; i < chars.length; i += 1) {
    const c = chars[i];
    if (c === "「") {
      quote = true;
      continue;
    }
    if (c === "」") {
      quote = false;
      continue;
    }
    if (quote) {
      continue;
    }
    if (isOpenParen(c)) {
      depth += 1;
      continue;
    }
    if (isCloseParen(c) && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        return true;
      }
      continue;
    }
    if (depth === 1 && isLineBreak(c)) {
      return false;
    }
  }
  return false;
}

function isRomanLetterRun(text: string): boolean {
  return /^[ivxlcⅰ-ⅻⅠ-Ⅻ]+$/iu.test(text);
}

function isListMarker(inner: string): boolean {
  const text = inner.trim();
  if (!text) {
    return false;
  }
  if (isRomanLetterRun(text)) {
    return true;
  }
  if (Array.from(text).length > 4) {
    return false;
  }
  if (/^[0-9０-９]+$/u.test(text)) {
    return true;
  }
  if (/^(i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii)$/iu.test(text)) {
    return true;
  }
  if (Array.from(text).every((c) => /[ⅰ-ⅻⅠ-Ⅻ]/u.test(c))) {
    return true;
  }
  if (
    Array.from(text).length === 1 &&
    (/[ア-ンぁ-ん]/u.test(text) || /[A-Za-z]/u.test(text) || isCircled(text))
  ) {
    return true;
  }
  return /^[一二三四五六七八九十百千]+$/u.test(text);
}

function isCircled(c: string): boolean {
  return /[①-⑳❶-❿㉑-㉟]/u.test(c);
}

function isLawChar(c: string): boolean {
  return /[\u3400-\u9fff\u3040-\u30ff々、，]/u.test(c);
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
  end = extendClause(chars, end);
  if (start > end || end > chars.length) {
    return null;
  }
  return { start, end, key: ident.key, display: ident.display, suppl };
}

function extendClause(chars: string[], end: number): number {
  let cursor = end;
  const paragraph = readMarkedUnit(chars, cursor, "項");
  if (paragraph !== null) {
    cursor = paragraph;
  }
  const item = readMarkedUnit(chars, cursor, "号");
  if (item === null) {
    return cursor;
  }
  cursor = item;
  while (chars[cursor] === "の") {
    const branch = takeNumeral(chars, cursor + 1);
    if (!branch) {
      break;
    }
    cursor = branch.end;
  }
  return cursor;
}

function readMarkedUnit(chars: string[], start: number, unit: string): number | null {
  let i = start;
  while (i < chars.length && /\s/u.test(chars[i])) {
    i += 1;
  }
  if (chars[i] !== "第") {
    return null;
  }
  const num = takeNumeral(chars, i + 1);
  if (!num || chars[num.end] !== unit) {
    return null;
  }
  return num.end + 1;
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
