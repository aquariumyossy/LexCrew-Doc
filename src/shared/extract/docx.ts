import {
  ChangeKind,
  ChangeNote,
  CommentNote,
  MAX_ANCHOR_CHARS,
  MAX_CHANGE_TEXT_CHARS,
  MAX_CHANGE_WHERE_CHARS,
  MAX_COMMENT_BODY_CHARS,
  MarkupList,
  clipNote,
} from "../attachment";
import { MAX_CHANGES_READ, MAX_COMMENTS_READ } from "../constants";
import type { FileText } from "../fileSource";
import { ListMark, wrapListMark } from "../listMark";
import { formatParagraphRef } from "../paragraphRef";
import { MARKUP_LEGEND, readMarkupBody } from "../markupText";
import { paragraphListMarks } from "./numbering";
import { scanXml, xmlAttr, xmlDate } from "./xml";

/** The parts of a `.docx` worth reading. Headers, footers and footnotes are left out. */
export type DocxParts = {
  /** `word/document.xml`. */
  document: string;
  /** `word/comments.xml`; absent when the file carries no comments. */
  comments?: string;
  /** `word/numbering.xml`; absent when the file has no list definitions. */
  numbering?: string;
  /** `word/styles.xml`; absent when the package has no styles part. */
  styles?: string;
};

type Mark = { kind: ChangeKind; author: string; date: string; text: string[] };

type BodyRead = {
  paragraphs: string[];
  changes: ChangeNote[];
  changesTruncated: boolean;
  /** Comment id to paragraph number where the range ends. */
  commentParagraphs: Map<string, number>;
};

function markKind(name: string): ChangeKind | null {
  switch (name) {
    case "w:ins":
      return "insert";
    case "w:del":
      return "delete";
    case "w:rPrChange":
    case "w:pPrChange":
      return "format";
    default:
      return null;
  }
}

/**
 * Walks the body once, keeping the three readings apart. An insertion is
 * already part of the body; a deletion is not, so it survives only as a note,
 * which is what places a proposal the body no longer shows.
 */
/** List labels sit outside the body text, same brackets as a live Word attachment. */
function showWithMark(text: string, mark: ListMark | null | undefined): string {
  if (!mark?.isListItem) {
    return text;
  }
  const badge = wrapListMark(mark);
  if (!badge) {
    return text;
  }
  return text ? `${badge}${text}` : badge;
}

function readBody(xml: string, listMarks: (ListMark | null)[]): BodyRead {
  const paragraphs: string[] = [];
  const changes: ChangeNote[] = [];
  const commentParagraphs = new Map<string, number>();
  const open = new Map<string, string[]>();
  const stack: string[] = [];
  const marks: Mark[] = [];
  let line: string[] = [];
  let pending: ChangeNote[] = [];
  let changesTruncated = false;
  let paragraphCounter = 0;

  const keepChange = (note: ChangeNote) => {
    if (changes.length >= MAX_CHANGES_READ) {
      changesTruncated = true;
      return;
    }
    changes.push(note);
  };

  const addBody = (text: string) => {
    line.push(text);
    for (const buffer of open.values()) {
      buffer.push(text);
    }
  };

  for (const event of scanXml(xml)) {
    if (event.kind === "text") {
      const leaf = stack[stack.length - 1];
      if (leaf !== "w:t" && leaf !== "w:delText") {
        continue;
      }
      if (leaf === "w:t" && !stack.includes("w:del")) {
        addBody(event.text);
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
      if (event.name === "w:p") {
        const text = line.join("").trim();
        const where = formatParagraphRef(paragraphCounter);
        const shown = showWithMark(text, listMarks[paragraphCounter - 1]);
        if (shown) {
          paragraphs.push(shown);
        }
        for (const note of pending) {
          keepChange({ ...note, where });
        }
        pending = [];
        line = [];
      }
      if (markKind(event.name) && marks.length) {
        const mark = marks.pop() as Mark;
        const text = clipNote(mark.text.join(""), MAX_CHANGE_TEXT_CHARS);
        if (text || mark.kind === "format") {
          pending.push({ kind: mark.kind, author: mark.author, date: mark.date, text, where: "" });
        }
      }
      continue;
    }

    switch (event.name) {
      case "w:p":
        if (!event.empty) {
          paragraphCounter += 1;
        }
        line = [];
        break;
      case "w:tab":
        addBody("\t");
        break;
      case "w:br":
      case "w:cr":
        addBody("\n");
        break;
      case "w:commentRangeStart":
        open.set(xmlAttr(event.attrs, "w:id"), []);
        break;
      case "w:commentRangeEnd": {
        const id = xmlAttr(event.attrs, "w:id");
        const buffer = open.get(id);
        if (buffer) {
          commentParagraphs.set(id, paragraphCounter);
          open.delete(id);
        }
        break;
      }
      default:
        break;
    }

    const kind = markKind(event.name);
    if (kind && !event.empty) {
      marks.push({
        kind,
        author: xmlAttr(event.attrs, "w:author"),
        date: xmlDate(xmlAttr(event.attrs, "w:date")),
        text: [],
      });
    } else if (kind === "format" && event.empty) {
      pending.push({
        kind,
        author: xmlAttr(event.attrs, "w:author"),
        date: xmlDate(xmlAttr(event.attrs, "w:date")),
        text: "",
        where: "",
      });
    }

    if (!event.empty) {
      stack.push(event.name);
    }
  }

  return { paragraphs, changes, changesTruncated, commentParagraphs };
}

function readComments(
  xml: string,
  commentParagraphs: Map<string, number>
): { items: CommentNote[]; truncated: boolean } {
  const items: CommentNote[] = [];
  let truncated = false;
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
      if (event.name === "w:p" && current) {
        current.text.push("\n");
      }
      if (event.name === "w:comment" && current) {
        const content = clipNote(current.text.join(""), MAX_COMMENT_BODY_CHARS);
        if (content) {
          if (items.length >= MAX_COMMENTS_READ) {
            truncated = true;
          } else {
            items.push({
              author: current.author,
              date: current.date,
              resolved: false,
              anchor: formatParagraphRef(commentParagraphs.get(current.id) || 1),
              content,
              replies: [],
            });
          }
        }
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

  return { items, truncated };
}

export function extractDocx(parts: DocxParts): FileText {
  const document = parts.document || "";
  const marks = paragraphListMarks(document, parts.numbering || "", parts.styles || "");
  const markup = readMarkupBody(document, parts.comments);
  const bodyRead = readBody(document, marks);
  const fullComments = parts.comments
    ? readComments(parts.comments, bodyRead.commentParagraphs)
    : { items: [] as CommentNote[], truncated: false };

  if (markup.hasInlineMarkup) {
    const bodyLines = markup.markedParagraphs
      .map((line, index) => showWithMark(line, marks[index]))
      .filter((line) => line.trim());
    const body = bodyLines.length ? `${MARKUP_LEGEND}\n\n${bodyLines.join("\n")}` : "";
    return {
      origin: "text",
      body,
      comments: {
        items: fullComments.items
          .filter((note) => note.replies.length > 0 || note.resolved)
          .concat(markup.commentsForAppendix),
        truncated: fullComments.truncated,
        error: "",
      },
      changes: {
        items: markup.changes,
        truncated: markup.changesTruncated,
        error: "",
      },
      truncated: false,
      inlineCommentCount: markup.inlineCommentCount,
    };
  }

  const comments = fullComments;

  const commentList: MarkupList<CommentNote> = {
    items: comments.items,
    truncated: comments.truncated,
    error: "",
  };
  const changeList: MarkupList<ChangeNote> = {
    items: bodyRead.changes,
    truncated: bodyRead.changesTruncated,
    error: "",
  };

  return {
    origin: "text",
    body: bodyRead.paragraphs.join("\n"),
    comments: commentList,
    changes: changeList,
    truncated: false,
  };
}
