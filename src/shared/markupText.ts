import { ChangeKind, ChangeNote, CommentNote, clipNote, MAX_CHANGE_TEXT_CHARS } from "./attachment";
import { MAX_CHANGES_READ } from "./constants";
import { formatParagraphRef } from "./paragraphRef";
import { scanXml, xmlAttr, xmlDate } from "./extract/xml";

export const MARKUP_LEGEND = "※ 〔-〕削除  〔+〕挿入  〔注〕コメント";

type RunKind = "normal" | "ins" | "del";

type ParsedComment = { id: string; author: string; date: string; text: string };

type Mark = { kind: ChangeKind; author: string; date: string; text: string[] };

export type MarkupBodyRead = {
  /** Plain reviewed paragraphs (no list marks); one entry per non-empty w:p. */
  paragraphs: string[];
  /** One marked string per w:p in document order (includes empty paragraphs). */
  markedParagraphs: string[];
  /** Total w:p elements seen (including empty), for parity with Word paragraph count. */
  paragraphCount: number;
  /** Insert/delete/format changes not inlined (format only after phase 2 filtering). */
  changes: ChangeNote[];
  changesTruncated: boolean;
  hasInlineMarkup: boolean;
  /** Extra markup character count over plain paragraphs. */
  markupOverhead: number;
  commentsForAppendix: CommentNote[];
  /** Comments embedded in the body as 〔注…〕. */
  inlineCommentCount: number;
};

class ParaBuilder {
  private out = "";
  private lastWasSpace = true;
  private markSign: "+" | "-" | null = null;
  private markAuthor = "";
  private markText = "";
  private markSpace = true;
  hasMarkup = false;

  pushRaw(text: string): void {
    this.flushMark();
    this.out += text;
    this.lastWasSpace = false;
    if (text.includes("〔")) {
      this.hasMarkup = true;
    }
  }

  pushChar(kind: RunKind, author: string, ch: string): void {
    if (kind === "normal") {
      this.flushMark();
      this.pushPlain(ch);
      return;
    }
    this.pushMarked(kind === "ins" ? "+" : "-", author, ch);
  }

  pushBreak(kind: RunKind, author: string): void {
    if (kind === "normal") {
      this.flushMark();
      this.out += "\n";
      this.lastWasSpace = true;
      return;
    }
    this.pushMarkedBreak(kind === "ins" ? "+" : "-", author);
  }

  pushTab(kind: RunKind, author: string): void {
    if (kind === "normal") {
      this.flushMark();
      this.out += "\t";
      this.lastWasSpace = true;
      return;
    }
    this.pushMarkedTab(kind === "ins" ? "+" : "-", author);
  }

  finish(): string {
    this.flushMark();
    return this.out.trim();
  }

  private pushPlain(ch: string): void {
    if (/\s/.test(ch)) {
      if (!this.lastWasSpace) {
        this.out += " ";
        this.lastWasSpace = true;
      }
      return;
    }
    this.out += ch;
    this.lastWasSpace = false;
  }

  private ensureMark(sign: "+" | "-", author: string): void {
    if (this.markSign === sign && this.markAuthor === author) {
      return;
    }
    this.flushMark();
    this.markSign = sign;
    this.markAuthor = author;
    this.markText = "";
    this.markSpace = true;
  }

  private pushMarked(sign: "+" | "-", author: string, ch: string): void {
    this.ensureMark(sign, author);
    if (/\s/.test(ch)) {
      if (!this.markSpace) {
        this.markText += " ";
        this.markSpace = true;
      }
      return;
    }
    this.markText += ch;
    this.markSpace = false;
  }

  private pushMarkedBreak(sign: "+" | "-", author: string): void {
    this.ensureMark(sign, author);
    this.markText += "\n";
    this.markSpace = true;
  }

  private pushMarkedTab(sign: "+" | "-", author: string): void {
    this.ensureMark(sign, author);
    this.markText += "\t";
    this.markSpace = true;
  }

  private flushMark(): boolean {
    if (this.markSign === null) {
      return false;
    }
    const formatted = formatRev(this.markSign, this.markAuthor, this.markText);
    if (formatted) {
      this.out += formatted;
      this.hasMarkup = true;
    }
    this.markSign = null;
    this.markAuthor = "";
    this.markText = "";
    this.markSpace = true;
    return Boolean(formatted);
  }
}

function formatRev(sign: "+" | "-", author: string, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  if (!author) {
    return `〔${sign} ${trimmed}〕`;
  }
  return `〔${sign}${author}: ${trimmed}〕`;
}

export function formatInlineComment(author: string, date: string, text: string, resolved = false): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  let head = resolved ? "〔注 解決済" : "〔注";
  if (author) {
    head += ` ${author}`;
  }
  if (date) {
    head += ` ${date}`;
  }
  return `${head}: ${trimmed}〕`;
}

function markKind(name: string): ChangeKind | null {
  switch (name) {
    case "w:ins":
    case "w:moveTo":
      return "insert";
    case "w:del":
    case "w:moveFrom":
      return "delete";
    case "w:rPrChange":
    case "w:pPrChange":
      return "format";
    default:
      return null;
  }
}

function currentRun(ins: string[], del: string[]): { kind: RunKind; author: string } {
  if (del.length) {
    return { kind: "del", author: del[del.length - 1] };
  }
  if (ins.length) {
    return { kind: "ins", author: ins[ins.length - 1] };
  }
  return { kind: "normal", author: "" };
}

function parseCommentsXml(xml: string): Map<string, ParsedComment> {
  const out = new Map<string, ParsedComment>();
  const stack: string[] = [];
  let current: { id: string; author: string; date: string; text: string[] } | null = null;
  for (const event of scanXml(xml)) {
    if (event.kind === "text") {
      if (current && stack[stack.length - 1] === "w:t") {
        current.text.push(event.text);
      }
      continue;
    }
    if (event.kind === "close") {
      const found = stack.lastIndexOf(event.name);
      if (found >= 0) {
        stack.length = found;
      }
      if (event.name === "w:comment" && current) {
        out.set(current.id, {
          id: current.id,
          author: current.author,
          date: current.date,
          text: current.text.join("").trim(),
        });
        current = null;
      }
      continue;
    }
    if (event.name === "w:comment" && !event.empty) {
      current = {
        id: xmlAttr(event.attrs, "w:id"),
        author: xmlAttr(event.attrs, "w:author"),
        date: xmlDate(xmlAttr(event.attrs, "w:date")),
        text: [],
      };
    }
    if (!event.empty) {
      stack.push(event.name);
    }
  }
  return out;
}

/** Strip inline GURI markup markers from a line for quote resolution. */
export function stripInlineMarkup(text: string): string {
  return text.replace(/〔[+-\u6ce8][^〕]*〕/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Turn user-written marker-like brackets into fullwidth ones on display-only
 * text. Real revision markers are added after this runs (via pushRaw).
 */
export function neutralizeLiteralMarkup(text: string): string {
  return text.replace(/〔([+-\u6ce8][^〕]*)〕/g, (_match, inner) => `［${inner}］`);
}

/**
 * Walk document XML once, producing plain and marked paragraph text plus
 * format-only change notes. Insert/delete live inline when this path is used.
 */
export function readMarkupBody(documentXml: string, commentsXml?: string): MarkupBodyRead {
  const comments = commentsXml ? parseCommentsXml(commentsXml) : new Map<string, ParsedComment>();
  const emittedComments = new Set<string>();
  const commentsForAppendix: CommentNote[] = [];

  const paragraphs: string[] = [];
  const markedParagraphs: string[] = [];
  const changes: ChangeNote[] = [];
  let changesTruncated = false;
  let paragraphCount = 0;
  let hasInlineMarkup = false;
  let markupOverhead = 0;

  const stack: string[] = [];
  const ins: string[] = [];
  const del: string[] = [];
  const marks: Mark[] = [];
  let pending: ChangeNote[] = [];
  let builder: ParaBuilder | null = null;
  let plainParts: string[] = [];

  const keepChange = (note: ChangeNote) => {
    if (note.kind === "insert" || note.kind === "delete") {
      return;
    }
    if (changes.length >= MAX_CHANGES_READ) {
      changesTruncated = true;
      return;
    }
    changes.push(note);
  };

  const addPlain = (text: string) => {
    plainParts.push(text);
  };

  const emitComment = (id: string) => {
    if (!id || emittedComments.has(id)) {
      return;
    }
    emittedComments.add(id);
    const comment = comments.get(id);
    if (!comment || !comment.text.trim()) {
      return;
    }
    const mark = formatInlineComment(comment.author, comment.date, comment.text);
    if (!mark) {
      return;
    }
    if (builder) {
      builder.pushRaw(mark);
    }
    hasInlineMarkup = true;
  };

  for (const event of scanXml(documentXml)) {
    if (event.kind === "text") {
      const leaf = stack[stack.length - 1];
      if (leaf !== "w:t" && leaf !== "w:delText") {
        continue;
      }
      const inDel = stack.includes("w:del") || stack.includes("w:moveFrom");
      if (leaf === "w:t" && !inDel) {
        const plain = neutralizeLiteralMarkup(event.text);
        addPlain(plain);
        if (builder) {
          const { kind, author } = currentRun(ins, del);
          for (const ch of plain) {
            builder.pushChar(kind, author, ch);
          }
        }
      } else if (inDel && builder) {
        const { kind, author } = currentRun(ins, del);
        for (const ch of event.text) {
          builder.pushChar(kind, author, ch);
        }
      }
      if (marks.length) {
        marks[marks.length - 1].text.push(event.text);
      }
      continue;
    }

    if (event.kind === "close") {
      const found = stack.lastIndexOf(event.name);
      if (found >= 0) {
        stack.length = found;
      }
      if (event.name === "w:ins" || event.name === "w:moveTo") {
        ins.pop();
      }
      if (event.name === "w:del" || event.name === "w:moveFrom") {
        del.pop();
      }
      if (event.name === "w:p") {
        paragraphCount += 1;
        const plain = plainParts.join("").trim();
        const markedText = builder ? builder.finish() : plain;
        markedParagraphs.push(markedText);
        markupOverhead += Math.max(0, markedText.length - plain.length);
        if (plain || markedText) {
          paragraphs.push(plain || markedText);
          if (builder?.hasMarkup) {
            hasInlineMarkup = true;
          }
        }
        for (const note of pending) {
          keepChange({ ...note, where: formatParagraphRef(paragraphCount) });
        }
        pending = [];
        plainParts = [];
        builder = null;
      }
      const kind = markKind(event.name);
      if (kind && marks.length) {
        const mark = marks.pop() as Mark;
        const text = clipNote(mark.text.join(""), MAX_CHANGE_TEXT_CHARS);
        if (text || mark.kind === "format") {
          pending.push({ kind: mark.kind, author: mark.author, date: mark.date, text, where: "" });
        }
      }
      continue;
    }

    if (event.name === "w:ins" || event.name === "w:moveTo") {
      if (!event.empty) {
        ins.push(xmlAttr(event.attrs, "w:author"));
        stack.push(event.name);
      }
      continue;
    }
    if (event.name === "w:del" || event.name === "w:moveFrom") {
      if (!event.empty) {
        del.push(xmlAttr(event.attrs, "w:author"));
        stack.push(event.name);
      }
      continue;
    }

    switch (event.name) {
      case "w:p":
        if (!event.empty) {
          builder = new ParaBuilder();
          stack.push(event.name);
        }
        break;
      case "w:tab":
        addPlain("\t");
        if (builder) {
          const { kind, author } = currentRun(ins, del);
          builder.pushTab(kind, author);
        }
        break;
      case "w:br":
      case "w:cr":
        addPlain("\n");
        if (builder) {
          const { kind, author } = currentRun(ins, del);
          builder.pushBreak(kind, author);
        }
        break;
      case "w:commentRangeEnd":
      case "w:commentReference":
        emitComment(xmlAttr(event.attrs, "w:id"));
        break;
      default:
        break;
    }

    const kind = markKind(event.name);
    if (kind && !event.empty && event.name !== "w:ins" && event.name !== "w:moveTo" && event.name !== "w:del" && event.name !== "w:moveFrom") {
      marks.push({
        kind,
        author: xmlAttr(event.attrs, "w:author"),
        date: xmlDate(xmlAttr(event.attrs, "w:date")),
        text: [],
      });
      stack.push(event.name);
    } else if (kind === "format" && event.empty) {
      pending.push({
        kind,
        author: xmlAttr(event.attrs, "w:author"),
        date: xmlDate(xmlAttr(event.attrs, "w:date")),
        text: "",
        where: "",
      });
    } else if (!event.empty && event.name !== "w:p") {
      stack.push(event.name);
    }
  }

  for (const comment of comments.values()) {
    if (emittedComments.has(comment.id)) {
      continue;
    }
    commentsForAppendix.push({
      author: comment.author,
      date: comment.date,
      resolved: false,
      anchor: "",
      content: clipNote(comment.text, 400),
      replies: [],
    });
  }

  return {
    paragraphs,
    markedParagraphs,
    paragraphCount,
    changes,
    changesTruncated,
    hasInlineMarkup,
    markupOverhead,
    commentsForAppendix,
    inlineCommentCount: emittedComments.size,
  };
}

/** Extract `word/document.xml` from a flat OPC package returned by Word getOoxml(). */
export function documentXmlFromPackage(ooxml: string): string {
  const match = ooxml.match(/<pkg:part[^>]+\/word\/document\.xml[^>]*>[\s\S]*?<pkg:xmlData>([\s\S]*?)<\/pkg:xmlData>/i);
  return match ? match[1] : ooxml;
}

/** Extract optional `word/comments.xml` from the same package. */
export function commentsXmlFromPackage(ooxml: string): string | undefined {
  const match = ooxml.match(/<pkg:part[^>]+\/word\/comments\.xml[^>]*>[\s\S]*?<pkg:xmlData>([\s\S]*?)<\/pkg:xmlData>/i);
  return match ? match[1] : undefined;
}
