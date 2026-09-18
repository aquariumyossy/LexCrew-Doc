import fs from "fs";
import os from "os";
import path from "path";
import type DatabaseConstructor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import {
  ConversationDetail,
  ConversationSummary,
  NewMessage,
  StoredMessage,
  StoredRole,
  UNTITLED_CONVERSATION,
  conversationTitle,
} from "../shared/history";
import { joinArgosScopes } from "../shared/argos";
import { CommittedFile, parseCommittedFiles } from "../shared/fileSource";
import { Usage } from "../shared/stripThinking";
import { normalizeToolCalls } from "../shared/tools";

/** Mirrors `dirs::data_dir()` in the Tauri sidecar so both use one database. */
function dataDir(): string {
  if (process.platform === "win32") {
    return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}

export function historyFilePath(): string {
  return path.join(dataDir(), "GURI", "history.db");
}

/**
 * Versioned so later phases (attachments) can add tables without rewriting an
 * existing database.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    document_key TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    reasoning_content TEXT NOT NULL DEFAULT '',
    tool_calls_json TEXT NOT NULL DEFAULT '',
    tool_call_id TEXT NOT NULL DEFAULT '',
    usage_json TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_by_conversation ON messages(conversation_id, id);
  CREATE INDEX conversations_by_document ON conversations(document_key, updated_at DESC);
  `,
  `ALTER TABLE conversations ADD COLUMN argos_path_prefix TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE conversations ADD COLUMN document_path TEXT NOT NULL DEFAULT '';`,
  // Attached files are read once and kept here, not copied into every message.
  `ALTER TABLE conversations ADD COLUMN file_sources TEXT NOT NULL DEFAULT '';`,
];

type ConversationRow = {
  id: string;
  title: string;
  document_key: string;
  document_path: string;
  created_at: string;
  updated_at: string;
  argos_path_prefix: string;
  message_count: number;
};

type MessageRow = {
  id: number;
  role: string;
  content: string;
  reasoning_content: string;
  tool_calls_json: string;
  tool_call_id: string;
  usage_json: string;
  created_at: string;
};

function migrate(db: Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const current = (db.pragma("user_version", { simple: true }) as number) || 0;
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec(MIGRATIONS[version]);
    db.pragma(`user_version = ${version + 1}`);
  }
}

function toRole(value: string): StoredRole {
  return value === "assistant" || value === "tool" ? value : "user";
}

function toUsage(raw: string): Usage | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as Usage;
  } catch {
    return null;
  }
}

function toSummary(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    documentKey: row.document_key,
    documentPath: row.document_path || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    argosPathPrefix: row.argos_path_prefix || "",
  };
}

function toMessage(row: MessageRow): StoredMessage {
  let toolCalls: unknown = [];
  if (row.tool_calls_json) {
    try {
      toolCalls = JSON.parse(row.tool_calls_json);
    } catch {
      toolCalls = [];
    }
  }
  return {
    id: row.id,
    role: toRole(row.role),
    content: row.content,
    reasoningContent: row.reasoning_content,
    toolCalls: normalizeToolCalls(toolCalls),
    toolCallId: row.tool_call_id,
    usage: toUsage(row.usage_json),
    createdAt: row.created_at,
  };
}

function newId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export type HistoryStore = {
  listConversations(documentKey?: string): ConversationSummary[];
  getConversation(id: string): ConversationDetail | null;
  createConversation(
    documentKey: string,
    title?: string,
    documentPath?: string
  ): ConversationSummary;
  appendMessage(conversationId: string, message: NewMessage): StoredMessage | null;
  setArgosPathPrefix(conversationId: string, pathPrefixes: string[]): ConversationSummary | null;
  setFiles(conversationId: string, files: CommittedFile[]): CommittedFile[] | null;
  setDocumentPath(documentKey: string, documentPath: string): number;
  deleteConversation(id: string): boolean;
  close(): void;
};

const SUMMARY_COLUMNS = `
  c.id, c.title, c.document_key, c.document_path, c.created_at, c.updated_at, c.argos_path_prefix,
  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
`;

export function openHistory(filePath: string): HistoryStore {
  if (filePath !== ":memory:") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  // Required at call time: the task pane bundle must never pull in a native module.
  const Database = require("better-sqlite3") as typeof DatabaseConstructor;
  const db = new Database(filePath);
  migrate(db);

  const selectOne = db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM conversations c WHERE c.id = ?`);
  // Kept out of SUMMARY_COLUMNS on purpose: that list also serves the history
  // dialog, which would then carry every conversation's file text.
  const selectFiles = db.prepare(`SELECT file_sources FROM conversations WHERE id = ?`);

  const readFiles = (id: string): CommittedFile[] => {
    const row = selectFiles.get(id) as { file_sources?: string } | undefined;
    return parseCommittedFiles(row?.file_sources || "");
  };

  return {
    listConversations(documentKey?: string): ConversationSummary[] {
      const rows = documentKey
        ? (db
            .prepare(
              `SELECT ${SUMMARY_COLUMNS} FROM conversations c WHERE c.document_key = ? ORDER BY c.updated_at DESC`
            )
            .all(documentKey) as ConversationRow[])
        : (db
            .prepare(`SELECT ${SUMMARY_COLUMNS} FROM conversations c ORDER BY c.updated_at DESC`)
            .all() as ConversationRow[]);
      return rows.map(toSummary);
    },

    getConversation(id: string): ConversationDetail | null {
      const row = selectOne.get(id) as ConversationRow | undefined;
      if (!row) {
        return null;
      }
      const messages = db
        .prepare(
          `SELECT id, role, content, reasoning_content, tool_calls_json, tool_call_id, usage_json, created_at
           FROM messages WHERE conversation_id = ? ORDER BY id`
        )
        .all(id) as MessageRow[];
      return {
        conversation: toSummary(row),
        messages: messages.map(toMessage),
        files: readFiles(id),
      };
    },

    createConversation(
      documentKey: string,
      title?: string,
      documentPath?: string
    ): ConversationSummary {
      const id = newId();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO conversations (id, title, document_key, document_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        (title || "").trim() || UNTITLED_CONVERSATION,
        documentKey || "",
        documentPath || "",
        now,
        now
      );
      return toSummary(selectOne.get(id) as ConversationRow);
    },

    appendMessage(conversationId: string, message: NewMessage): StoredMessage | null {
      const existing = selectOne.get(conversationId) as ConversationRow | undefined;
      if (!existing) {
        return null;
      }
      const now = new Date().toISOString();
      const content = message.content || "";
      const info = db
        .prepare(
          `INSERT INTO messages
             (conversation_id, role, content, reasoning_content, tool_calls_json, tool_call_id, usage_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          conversationId,
          toRole(message.role),
          content,
          message.reasoningContent || "",
          message.toolCalls?.length ? JSON.stringify(message.toolCalls) : "",
          message.toolCallId || "",
          message.usage ? JSON.stringify(message.usage) : "",
          now
        );

      const named =
        existing.title === UNTITLED_CONVERSATION && message.role === "user" && content.trim()
          ? conversationTitle(content)
          : existing.title;
      db.prepare(`UPDATE conversations SET updated_at = ?, title = ? WHERE id = ?`).run(
        now,
        named,
        conversationId
      );

      const row = db
        .prepare(
          `SELECT id, role, content, reasoning_content, tool_calls_json, tool_call_id, usage_json, created_at
           FROM messages WHERE id = ?`
        )
        .get(info.lastInsertRowid) as MessageRow;
      return toMessage(row);
    },

    setArgosPathPrefix(conversationId: string, pathPrefixes: string[]): ConversationSummary | null {
      const existing = selectOne.get(conversationId) as ConversationRow | undefined;
      if (!existing) {
        return null;
      }
      const now = new Date().toISOString();
      db.prepare(`UPDATE conversations SET argos_path_prefix = ?, updated_at = ? WHERE id = ?`).run(
        joinArgosScopes(pathPrefixes),
        now,
        conversationId
      );
      return toSummary(selectOne.get(conversationId) as ConversationRow);
    },

    setFiles(conversationId: string, files: CommittedFile[]): CommittedFile[] | null {
      const existing = selectOne.get(conversationId) as ConversationRow | undefined;
      if (!existing) {
        return null;
      }
      const kept = parseCommittedFiles(files);
      const now = new Date().toISOString();
      db.prepare(`UPDATE conversations SET file_sources = ?, updated_at = ? WHERE id = ?`).run(
        kept.length ? JSON.stringify(kept) : "",
        now,
        conversationId
      );
      return readFiles(conversationId);
    },

    setDocumentPath(documentKey: string, documentPath: string): number {
      if (!documentKey) {
        return 0;
      }
      return db
        .prepare(`UPDATE conversations SET document_path = ? WHERE document_key = ?`)
        .run(documentPath || "", documentKey).changes;
    },

    deleteConversation(id: string): boolean {
      return db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id).changes > 0;
    },

    close(): void {
      db.close();
    },
  };
}

let shared: HistoryStore | undefined;

export function getHistory(): HistoryStore {
  if (!shared) {
    shared = openHistory(historyFilePath());
  }
  return shared;
}

export function setHistoryForTests(store: HistoryStore | undefined): void {
  shared = store;
}
