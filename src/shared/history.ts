import { CommittedFile } from "./fileSource";
import { Usage } from "./stripThinking";
import { ToolCall } from "./tools";

/** System prompts are rebuilt on every turn, so only these roles are stored. */
export type StoredRole = "user" | "assistant" | "tool";

export type ConversationSummary = {
  id: string;
  title: string;
  documentKey: string;
  /** Word の `document.url`。未保存や古い行は空。 */
  documentPath: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  argosPathPrefix: string;
};

export type StoredMessage = {
  id: number;
  role: StoredRole;
  content: string;
  reasoningContent: string;
  toolCalls: ToolCall[];
  toolCallId: string;
  usage: Usage | null;
  createdAt: string;
};

/**
 * The files ride on the detail rather than the summary: the history dialog
 * lists every conversation, and the summary columns are shared with that query,
 * so a full text here would ship every conversation's attachments to open it.
 */
export type ConversationDetail = {
  conversation: ConversationSummary;
  messages: StoredMessage[];
  files: CommittedFile[];
};

export type NewMessage = {
  role: StoredRole;
  content?: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  usage?: Usage | null;
};

export const UNTITLED_CONVERSATION = "新しい会話";
export const UNSAVED_DOCUMENT_LABEL = "未保存の文書";
export const UNKNOWN_DOCUMENT_LABEL = "不明な文書";
const TITLE_CHARS = 40;

export function conversationTitle(text: string): string {
  const firstLine = (text || "").split("\n").find((line) => line.trim()) || "";
  const trimmed = firstLine.trim();
  if (!trimmed) {
    return UNTITLED_CONVERSATION;
  }
  return trimmed.length > TITLE_CHARS ? `${trimmed.slice(0, TITLE_CHARS)}…` : trimmed;
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Word / ファイル URL / Windows パスから表示用のファイル名だけを取る。 */
export function documentFileName(path: string): string {
  const trimmed = (path || "").trim();
  if (!trimmed) {
    return "";
  }

  let candidate = trimmed;
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "file:") {
        let pathname = decodePath(parsed.pathname);
        if (/^\/[A-Za-z]:/.test(pathname)) {
          pathname = pathname.slice(1);
        }
        candidate = pathname.replace(/\//g, "\\");
      } else {
        candidate = decodePath(parsed.pathname);
      }
    }
  } catch {
    candidate = trimmed;
  }

  const unified = candidate.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = unified.split("/").filter(Boolean).pop() || "";
  return decodePath(base);
}

export function conversationDocumentLabel(
  conversation: Pick<ConversationSummary, "documentKey" | "documentPath">,
  currentDocumentKey = "",
  currentDocumentPath = ""
): string {
  const isCurrent = Boolean(currentDocumentKey) && conversation.documentKey === currentDocumentKey;
  const path = isCurrent
    ? currentDocumentPath || conversation.documentPath
    : conversation.documentPath;
  const name = documentFileName(path || "");
  if (name) {
    return name;
  }
  return isCurrent ? UNSAVED_DOCUMENT_LABEL : UNKNOWN_DOCUMENT_LABEL;
}

export type DocumentGroup = {
  documentKey: string;
  documentPath: string;
  conversations: ConversationSummary[];
};

/** An empty key is not an open document, so nothing is current. */
export function partitionConversations<T extends { documentKey: string }>(
  conversations: T[],
  documentKey: string
): { here: T[]; elsewhere: T[] } {
  if (!documentKey) {
    return { here: [], elsewhere: conversations.slice() };
  }
  const here: T[] = [];
  const elsewhere: T[] = [];
  for (const conversation of conversations) {
    if (conversation.documentKey === documentKey) {
      here.push(conversation);
    } else {
      elsewhere.push(conversation);
    }
  }
  return { here, elsewhere };
}

/** Keep newest-first order, grouping later rows into the first sighting of that document. */
export function groupConversationsByDocument(
  conversations: ConversationSummary[]
): DocumentGroup[] {
  const groups = new Map<string, DocumentGroup>();
  const order: string[] = [];
  for (const conversation of conversations) {
    const groupKey = conversation.documentKey
      ? `key:${conversation.documentKey}`
      : conversation.documentPath
        ? `path:${conversation.documentPath}`
        : "unknown";
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        documentKey: conversation.documentKey,
        documentPath: conversation.documentPath || "",
        conversations: [],
      };
      groups.set(groupKey, group);
      order.push(groupKey);
    } else if (!group.documentPath && conversation.documentPath) {
      group.documentPath = conversation.documentPath;
    }
    group.conversations.push(conversation);
  }
  return order.map((key) => groups.get(key) as DocumentGroup);
}
