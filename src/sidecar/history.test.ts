import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { HistoryStore, openHistory, setHistoryForTests } from "./history";

let store: HistoryStore;

beforeEach(() => {
  store = openHistory(":memory:");
  setHistoryForTests(store);
});

afterEach(() => {
  setHistoryForTests(undefined);
  store.close();
  vi.restoreAllMocks();
});

describe("conversation history", () => {
  it("creates, names, reads and deletes a conversation", async () => {
    const app = createApp();

    const created = await request(app).post("/api/conversations").send({ documentKey: "docA" });
    expect(created.status).toBe(200);
    expect(created.body.title).toBe("新しい会話");
    const id = created.body.id as string;

    await request(app).post(`/api/conversations/${id}/messages`).send({
      role: "user",
      content: "この条項を点検して",
    });
    const assistant = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .send({
        role: "assistant",
        content: "コメントを 2 件付けました。",
        reasoningContent: "内部の検討",
        toolCalls: [
          { id: "c1", type: "function", function: { name: "insert_comment", arguments: "{}" } },
        ],
        usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14, reasoningTokens: 2 },
      });
    expect(assistant.status).toBe(200);

    const detail = await request(app).get(`/api/conversations/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.conversation.title).toBe("この条項を点検して");
    expect(detail.body.conversation.messageCount).toBe(2);
    expect(detail.body.messages[1].reasoningContent).toBe("内部の検討");
    expect(detail.body.messages[1].toolCalls[0].function.name).toBe("insert_comment");
    expect(detail.body.messages[1].usage.totalTokens).toBe(14);

    const removed = await request(app).delete(`/api/conversations/${id}`);
    expect(removed.status).toBe(200);
    expect((await request(app).get(`/api/conversations/${id}`)).status).toBe(404);
  });

  it("lists conversations for one document, newest first", async () => {
    const app = createApp();
    const first = await request(app).post("/api/conversations").send({ documentKey: "docA" });
    await request(app).post("/api/conversations").send({ documentKey: "docB" });
    const second = await request(app).post("/api/conversations").send({ documentKey: "docA" });

    await request(app).post(`/api/conversations/${first.body.id}/messages`).send({
      role: "user",
      content: "あとから書いた",
    });

    const scoped = await request(app).get("/api/conversations").query({ documentKey: "docA" });
    expect(scoped.body.conversations.map((c: { id: string }) => c.id)).toEqual([
      first.body.id,
      second.body.id,
    ]);

    const all = await request(app).get("/api/conversations");
    expect(all.body.conversations).toHaveLength(3);
  });

  it("answers 404 for an unknown conversation", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/conversations/nope/messages")
      .send({ role: "user", content: "x" });
    expect(res.status).toBe(404);
  });

  it("keeps conversation bodies out of the logs", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const app = createApp();
    const created = await request(app).post("/api/conversations").send({ documentKey: "docA" });
    await request(app).post(`/api/conversations/${created.body.id}/messages`).send({
      role: "assistant",
      content: "SECRET_BODY",
      reasoningContent: "SECRET_THOUGHT",
    });

    const dumped = [...info.mock.calls, ...error.mock.calls]
      .map((c) => JSON.stringify(c))
      .join("\n");
    expect(dumped).not.toContain("SECRET_BODY");
    expect(dumped).not.toContain("SECRET_THOUGHT");
  });

  it("stores Argos path prefixes on the conversation", async () => {
    const app = createApp();
    const created = await request(app).post("/api/conversations").send({ documentKey: "docA" });
    expect(created.body.argosPathPrefix).toBe("");

    const updated = await request(app)
      .put(`/api/conversations/${created.body.id}/argos-scope`)
      .send({ pathPrefixes: ["C:\\案件A", "C:\\案件A\\子", "C:\\案件B"] });
    expect(updated.status).toBe(200);
    expect(updated.body.argosPathPrefix).toBe("C:\\案件A\nC:\\案件B");
  });

  it("keeps attached files on the conversation, not in every message", async () => {
    const app = createApp();
    const created = await request(app).post("/api/conversations").send({ documentKey: "docA" });
    const id = created.body.id as string;

    const file = {
      id: "f1",
      name: "契約.docx",
      origin: "text",
      body: "第1条（目的）",
      comments: {
        items: [
          {
            author: "乙川",
            date: "2026-03-01",
            resolved: false,
            anchor: "第1条",
            content: "主体を確認",
            replies: [],
          },
        ],
        truncated: false,
        error: "",
      },
      changes: { items: [], truncated: false, error: "" },
      truncated: false,
      size: 1024,
      mtime: 1700000000000,
    };

    const stored = await request(app)
      .put(`/api/conversations/${id}/files`)
      .send({ files: [file] });
    expect(stored.status).toBe(200);
    expect(stored.body.files).toEqual([file]);

    // A second turn re-sends the same set, which must not double the text.
    const again = await request(app)
      .put(`/api/conversations/${id}/files`)
      .send({ files: [file] });
    expect(again.body.files).toHaveLength(1);

    const detail = await request(app).get(`/api/conversations/${id}`);
    expect(detail.body.files).toEqual([file]);
    expect(detail.body.files[0].comments.items[0].content).toBe("主体を確認");
  });

  it("leaves file text out of the conversation list", async () => {
    const app = createApp();
    const created = await request(app).post("/api/conversations").send({ documentKey: "docA" });
    await request(app)
      .put(`/api/conversations/${created.body.id}/files`)
      .send({
        files: [{ id: "f1", name: "長い.pdf", body: "SECRET_FILE_BODY", origin: "text" }],
      });

    const listed = await request(app).get("/api/conversations");
    expect(JSON.stringify(listed.body)).not.toContain("SECRET_FILE_BODY");
    expect(listed.body.conversations[0]).not.toHaveProperty("files");
  });

  it("drops a stored file that lost its name and takes the whole set away", async () => {
    const app = createApp();
    const created = await request(app).post("/api/conversations").send({ documentKey: "docA" });
    const id = created.body.id as string;

    const mixed = await request(app)
      .put(`/api/conversations/${id}/files`)
      .send({
        files: [
          { id: "f1", body: "あ" },
          { id: "f2", name: "良.txt", body: "い" },
        ],
      });
    expect(mixed.body.files.map((row: { name: string }) => row.name)).toEqual(["良.txt"]);

    const cleared = await request(app).put(`/api/conversations/${id}/files`).send({ files: [] });
    expect(cleared.body.files).toEqual([]);
    expect((await request(app).get(`/api/conversations/${id}`)).body.files).toEqual([]);
  });

  it("answers 404 when the conversation for a file set is gone", async () => {
    const app = createApp();
    const res = await request(app).put("/api/conversations/nope/files").send({ files: [] });
    expect(res.status).toBe(404);
  });

  it("stores the Word file path and backfills it for a document", async () => {
    const app = createApp();
    const created = await request(app).post("/api/conversations").send({
      documentKey: "docA",
      documentPath: "file:///C:/案件/契約.docx",
    });
    expect(created.body.documentPath).toBe("file:///C:/案件/契約.docx");

    await request(app).post("/api/conversations").send({ documentKey: "docA" });
    const remembered = await request(app).put("/api/conversations/document-path").send({
      documentKey: "docA",
      documentPath: "C:\\案件\\契約_改.docx",
    });
    expect(remembered.status).toBe(200);
    expect(remembered.body.updated).toBe(2);

    const listed = await request(app).get("/api/conversations").query({ documentKey: "docA" });
    expect(
      listed.body.conversations.every(
        (row: { documentPath: string }) => row.documentPath === "C:\\案件\\契約_改.docx"
      )
    ).toBe(true);
  });
});
