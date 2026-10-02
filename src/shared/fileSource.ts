import {
  ChangeNote,
  CommentNote,
  MarkupList,
  changeChars,
  commentChars,
  markupCharBudget,
} from "./attachment";
import {
  CHARS_PER_TOKEN,
  CONVERSATION_BUDGET_RATIO,
  FILE_BUDGET_RATIO,
  MAX_ATTACHED_FILES,
  MAX_FILE_CHARS,
} from "./constants";

/** Whether the text came from the file's own text layer or from a vision read. */
export type FileOrigin = "text" | "ocr";

/**
 * What one read file contributes to a turn. Comments and tracked changes stay
 * out of the body for the same reason as in Word: a deletion the body no longer
 * shows is a proposal, not text.
 */
export type FileText = {
  origin: FileOrigin;
  body: string;
  comments: MarkupList<CommentNote>;
  changes: MarkupList<ChangeNote>;
  /** Set when a cap cut the text short. */
  truncated: boolean;
  /** Comments inlined in `body` as 〔注…〕. */
  inlineCommentCount?: number;
};

/**
 * The bytes behind a file, so the same one is not read twice and an edited file
 * of the same name is. The task pane has no OS path, so this is all there is.
 */
export type FileIdentity = {
  size: number;
  mtime: number;
};

/**
 * A file the user has picked but not yet sent. Only `ready` rides along. The
 * identity is known the moment it is picked, so it sits outside the states: a
 * file dropped twice has to be recognised while the first read is still going.
 */
type PickedFile = { id: string; name: string } & FileIdentity;

export type FileSource =
  | (PickedFile & { status: "extracting" })
  | (PickedFile & { status: "ocr"; done: number; total: number })
  | (PickedFile & { status: "ready" } & FileText)
  | (PickedFile & { status: "error"; message: string });

export type ReadyFileSource = Extract<FileSource, { status: "ready" }>;

/**
 * A file the conversation has kept. Unlike the Word body, these are read once:
 * a reference document is not expected to change under the conversation.
 */
export type CommittedFile = { id: string; name: string } & FileText & FileIdentity;

export function isReady(source: FileSource): source is ReadyFileSource {
  return source.status === "ready";
}

/** True while a file is still being read, which is when sending must wait. */
export function isPendingRead(source: FileSource): boolean {
  return source.status === "extracting" || source.status === "ocr";
}

export function commit(source: ReadyFileSource): CommittedFile {
  return {
    id: source.id,
    name: source.name,
    origin: source.origin,
    body: source.body,
    comments: source.comments,
    changes: source.changes,
    truncated: source.truncated,
    size: source.size,
    mtime: source.mtime,
  };
}

export function fileTextChars(text: FileText): number {
  const comments = text.comments.items.reduce((total, note) => total + commentChars(note), 0);
  const changes = text.changes.items.reduce((total, note) => total + changeChars(note), 0);
  return text.body.length + comments + changes;
}

export function filesChars(files: CommittedFile[]): number {
  return files.reduce((total, file) => total + fileTextChars(file), 0);
}

/** The same bytes under the same name. An edit changes the size or the stamp. */
export function sameFile(
  a: { name: string } & FileIdentity,
  b: { name: string } & FileIdentity
): boolean {
  return a.name === b.name && a.size === b.size && a.mtime === b.mtime;
}

/**
 * Adding the same read twice must leave one copy: a retried send, or a send that
 * failed after the message landed, both arrive here.
 */
export function mergeFiles(kept: CommittedFile[], incoming: CommittedFile[]): CommittedFile[] {
  const out = [...kept];
  for (const file of incoming) {
    const byId = out.findIndex((row) => row.id === file.id);
    if (byId >= 0) {
      out[byId] = file;
      continue;
    }
    // A file picked again after an edit replaces the stale read of that name.
    const byName = out.findIndex((row) => row.name === file.name);
    if (byName >= 0) {
      out[byName] = file;
      continue;
    }
    out.push(file);
  }
  return out;
}

/**
 * How many characters of attached file may ride along. `reservedChars` is what
 * the rest of this request already takes — the system prompt and the Word
 * attachment — so a narrow window does not leave the conversation with no room.
 */
export function fileCharBudget(contextLimit: number, reservedChars = 0): number {
  if (!Number.isFinite(contextLimit) || contextLimit <= 0) {
    return 0;
  }
  const fromLimit = Math.floor(contextLimit * FILE_BUDGET_RATIO * CHARS_PER_TOKEN);
  const forAttachments = Math.floor(
    contextLimit * (1 - CONVERSATION_BUDGET_RATIO) * CHARS_PER_TOKEN
  );
  const room = forAttachments - Math.max(0, reservedChars);
  return Math.max(0, Math.min(MAX_FILE_CHARS, fromLimit, room));
}

/**
 * Split a budget over sizes so no one file starves the others: everyone gets an
 * equal share, and whatever a small file leaves over goes back to the large ones.
 */
export function shareOut(sizes: number[], budget: number): number[] {
  const out = sizes.map(() => 0);
  let remaining = Math.max(0, budget);
  let open = sizes.map((_, index) => index);

  while (open.length > 0 && remaining > 0) {
    const share = Math.floor(remaining / open.length);
    if (share <= 0) {
      break;
    }
    const over = open.filter((index) => sizes[index] > share);
    if (over.length === open.length) {
      // Every file wants more than its share, so the shares are final.
      for (const index of open) {
        out[index] = share;
      }
      return out;
    }
    let used = 0;
    for (const index of open) {
      if (sizes[index] <= share) {
        out[index] = sizes[index];
        used += sizes[index];
      }
    }
    remaining -= used;
    open = over;
  }
  return out;
}

function clampMarkup<T>(
  list: MarkupList<T>,
  size: (item: T) => number,
  budget: number
): { list: MarkupList<T>; used: number } {
  if (list.error || !list.items.length) {
    return { list, used: 0 };
  }
  const items: T[] = [];
  let used = 0;
  for (const item of list.items) {
    const cost = size(item);
    if (used + cost > budget) {
      break;
    }
    items.push(item);
    used += cost;
  }
  const cut = items.length < list.items.length;
  return {
    list: { items, truncated: list.truncated || cut, error: list.error },
    used,
  };
}

/** Cut one file's text down to `allowance` characters, markup first. */
export function capFileText<T extends FileText>(file: T, allowance: number): T {
  if (fileTextChars(file) <= allowance) {
    return file;
  }
  // Markup keeps its own slice of the file's allowance, as it does for the
  // Word attachment: the counterparty's redlines are often the point. The two
  // lists split that slice by what they actually hold, so a file with only
  // comments does not leave half of it unused.
  const forMarkup = markupCharBudget(allowance);
  const [forComments, forChanges] = shareOut(
    [
      file.comments.items.reduce((total, note) => total + commentChars(note), 0),
      file.changes.items.reduce((total, note) => total + changeChars(note), 0),
    ],
    forMarkup
  );
  const comments = clampMarkup(file.comments, commentChars, forComments);
  const changes = clampMarkup(file.changes, changeChars, forChanges);
  const forBody = Math.max(0, allowance - comments.used - changes.used);
  return {
    ...file,
    body: file.body.slice(0, forBody),
    comments: comments.list,
    changes: changes.list,
    truncated: true,
  };
}

/** Fit the conversation's files into this turn's budget, fairly. */
export function clampFiles(files: CommittedFile[], budget: number): CommittedFile[] {
  const sizes = files.map((file) => fileTextChars(file));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= budget) {
    return files;
  }
  const allowances = shareOut(sizes, budget);
  return files.map((file, index) => capFileText(file, allowances[index]));
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function markupList<T>(value: unknown, item: (raw: unknown) => T | null): MarkupList<T> {
  const raw = (value || {}) as { items?: unknown; truncated?: unknown; error?: unknown };
  const items: T[] = [];
  if (Array.isArray(raw.items)) {
    for (const entry of raw.items) {
      const kept = item(entry);
      if (kept) {
        items.push(kept);
      }
    }
  }
  return { items, truncated: raw.truncated === true, error: str(raw.error) };
}

function comment(raw: unknown): CommentNote | null {
  const value = (raw || {}) as Record<string, unknown>;
  const content = str(value.content);
  if (!content) {
    return null;
  }
  const replies = Array.isArray(value.replies) ? value.replies : [];
  return {
    author: str(value.author),
    date: str(value.date),
    resolved: value.resolved === true,
    anchor: str(value.anchor),
    content,
    replies: replies.map((reply) => {
      const row = (reply || {}) as Record<string, unknown>;
      return { author: str(row.author), date: str(row.date), content: str(row.content) };
    }),
  };
}

const CHANGE_KINDS = new Set(["insert", "delete", "format", "other"]);

function change(raw: unknown): ChangeNote | null {
  const value = (raw || {}) as Record<string, unknown>;
  const kind = str(value.kind);
  if (!CHANGE_KINDS.has(kind)) {
    return null;
  }
  return {
    kind: kind as ChangeNote["kind"],
    author: str(value.author),
    date: str(value.date),
    text: str(value.text),
    where: str(value.where),
  };
}

/**
 * The stored JSON and the request body are both outside input, so they are
 * rebuilt field by field. A row written by an older build, or one hand-edited
 * in the database, must not reach the prompt as a half-shaped object.
 */
export function parseCommittedFiles(value: unknown): CommittedFile[] {
  if (typeof value === "string") {
    if (!value.trim()) {
      return [];
    }
    try {
      return parseCommittedFiles(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const out: CommittedFile[] = [];
  for (const entry of value.slice(0, MAX_ATTACHED_FILES)) {
    const raw = (entry || {}) as Record<string, unknown>;
    const id = str(raw.id);
    const name = str(raw.name);
    if (!id || !name) {
      continue;
    }
    out.push({
      id,
      name,
      origin: raw.origin === "ocr" ? "ocr" : "text",
      body: str(raw.body),
      comments: markupList(raw.comments, comment),
      changes: markupList(raw.changes, change),
      truncated: raw.truncated === true,
      size: num(raw.size),
      mtime: num(raw.mtime),
    });
  }
  return out;
}

/** The badge and the stored stub both say how much rode along. */
export function describeFiles(files: { name: string }[], chars: number): string {
  if (!files.length) {
    return "";
  }
  const count = files.length.toLocaleString("ja-JP");
  const size = chars.toLocaleString("ja-JP");
  return files.length === 1 ? `${files[0].name} ${size} 字` : `添付ファイル ${count} 件 ${size} 字`;
}
