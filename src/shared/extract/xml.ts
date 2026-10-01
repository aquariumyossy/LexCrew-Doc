/**
 * A tag scanner for the Office XML parts, small enough to run unchanged in the
 * task pane and under vitest. `DOMParser` exists only in the browser, and the
 * parts we read are machine-written, so a scanner is enough and keeps the
 * extraction testable with plain XML fixtures.
 */

export type XmlEvent =
  | { kind: "open"; name: string; attrs: string; empty: boolean }
  | { kind: "close"; name: string }
  | { kind: "text"; text: string };

/** Same events as `scanXml`, with the slice of the source each token covers. */
export type XmlToken = XmlEvent & { start: number; end: number };

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

export function decodeXmlText(raw: string): string {
  if (!raw.includes("&")) {
    return raw;
  }
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** Everything up to the matching quote, so an attribute holding `>` is safe. */
function endOfTag(xml: string, from: number): number {
  let quote = "";
  for (let at = from; at < xml.length; at += 1) {
    const ch = xml[at];
    if (quote) {
      if (ch === quote) {
        quote = "";
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") {
      return at;
    }
  }
  return -1;
}

export function* scanXmlTokens(xml: string): Generator<XmlToken> {
  let at = 0;
  while (at < xml.length) {
    const open = xml.indexOf("<", at);
    if (open < 0) {
      const tail = xml.slice(at);
      if (tail) {
        yield { kind: "text", text: decodeXmlText(tail), start: at, end: xml.length };
      }
      return;
    }
    if (open > at) {
      yield {
        kind: "text",
        text: decodeXmlText(xml.slice(at, open)),
        start: at,
        end: open,
      };
    }

    if (xml.startsWith("<!--", open)) {
      const close = xml.indexOf("-->", open);
      at = close < 0 ? xml.length : close + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const close = xml.indexOf("]]>", open);
      const to = close < 0 ? xml.length : close;
      yield { kind: "text", text: xml.slice(open + 9, to), start: open + 9, end: to };
      at = close < 0 ? xml.length : close + 3;
      continue;
    }
    if (xml.startsWith("<?", open) || xml.startsWith("<!", open)) {
      const close = endOfTag(xml, open);
      at = close < 0 ? xml.length : close + 1;
      continue;
    }

    const close = endOfTag(xml, open);
    if (close < 0) {
      return;
    }
    const inner = xml.slice(open + 1, close);
    const end = close + 1;
    at = end;
    if (inner.startsWith("/")) {
      yield { kind: "close", name: inner.slice(1).trim(), start: open, end };
      continue;
    }
    const empty = inner.endsWith("/");
    const body = empty ? inner.slice(0, -1) : inner;
    const space = body.search(/\s/);
    const name = space < 0 ? body : body.slice(0, space);
    yield {
      kind: "open",
      name: name.trim(),
      attrs: space < 0 ? "" : body.slice(space + 1),
      empty,
      start: open,
      end,
    };
  }
}

export function* scanXml(xml: string): Generator<XmlEvent> {
  for (const token of scanXmlTokens(xml)) {
    if (token.kind === "open") {
      yield { kind: "open", name: token.name, attrs: token.attrs, empty: token.empty };
    } else if (token.kind === "close") {
      yield { kind: "close", name: token.name };
    } else {
      yield { kind: "text", text: token.text };
    }
  }
}

/** Attribute names in the Office parts are plain, so they need no escaping. */
export function xmlAttr(attrs: string, name: string): string {
  if (!attrs || !/^[\w:.-]+$/.test(name)) {
    return "";
  }
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const hit = pattern.exec(attrs);
  if (!hit) {
    return "";
  }
  return decodeXmlText(hit[1] !== undefined ? hit[1] : hit[2] || "");
}

/** Word writes a full timestamp; the notes only ever show the day. */
export function xmlDate(value: string): string {
  const hit = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  return hit ? `${hit[1]}-${hit[2]}-${hit[3]}` : "";
}
