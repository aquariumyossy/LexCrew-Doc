import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings";

const insertDraftParagraphs = vi.hoisted(() => vi.fn());
const replaceSelection = vi.hoisted(() => vi.fn());
const insertComment = vi.hoisted(() => vi.fn());
const insertCitationText = vi.hoisted(() => vi.fn());

vi.mock("../word", () => ({
  insertDraftParagraphs,
  getSelectionInfo: vi.fn(),
  replaceSelection,
  replaceQuote: vi.fn(),
  insertComment,
  insertCitationComment: vi.fn(),
  insertCitationText,
  formatText: vi.fn(),
  formatParagraph: vi.fn(),
}));

vi.mock("../api", () => ({ search: vi.fn(), searchArgosIndex: vi.fn() }));

import { beginToolTurn, executeToolCall } from "./execute";
import { searchArgosIndex } from "../api";

function insertCall(args: unknown, id = "c1") {
  return {
    id,
    type: "function" as const,
    function: { name: "insert_blocks", arguments: JSON.stringify(args) },
  };
}

describe("insert_blocks placement", () => {
  beforeEach(() => {
    insertDraftParagraphs.mockReset();
    insertDraftParagraphs.mockResolvedValue({ placement: "cursor", after: "" });
    beginToolTurn();
  });

  it("puts the first chunk at the cursor and later chunks after the previous one", async () => {
    const signal = new AbortController().signal;
    await executeToolCall(
      insertCall({ blocks: [{ type: "clause", text: "定義する。", label: "第1条" }] }),
      DEFAULT_SETTINGS,
      signal
    );
    await executeToolCall(
      insertCall({ blocks: [{ type: "clause", text: "支払う。", label: "第7条" }] }, "c2"),
      DEFAULT_SETTINGS,
      signal
    );
    expect(insertDraftParagraphs.mock.calls[0][1]).toBe("cursor");
    expect(insertDraftParagraphs.mock.calls[1][1]).toBe("continue");
  });

  it("honours an explicit end on the first chunk", async () => {
    await executeToolCall(
      insertCall({ at: "end", blocks: [{ type: "body", text: "前文" }] }),
      DEFAULT_SETTINGS,
      new AbortController().signal
    );
    expect(insertDraftParagraphs.mock.calls[0][1]).toBe("end");
  });

  it("tells the model where the insert actually landed", async () => {
    insertDraftParagraphs.mockResolvedValue({ placement: "cursor", after: "第12条の末尾です。" });
    const fellBack = await executeToolCall(
      insertCall({ at: "continue", blocks: [{ type: "body", text: "前文" }] }),
      DEFAULT_SETTINGS,
      new AbortController().signal
    );
    expect(fellBack.content).toContain("カーソル位置");
    expect(fellBack.content).toContain("前の段落は「第12条の末尾です。」");

    insertDraftParagraphs.mockResolvedValue({ placement: "continue", after: "" });
    const continued = await executeToolCall(
      insertCall({ at: "continue", blocks: [{ type: "body", text: "前文" }] }, "c2"),
      DEFAULT_SETTINGS,
      new AbortController().signal
    );
    expect(continued.content).toContain("直前に挿入した段落の続き");
  });

  it("passes the quote through so the blocks go after a named clause", async () => {
    insertDraftParagraphs.mockResolvedValue({ placement: "quote", after: "前二項による解除は、" });
    const result = await executeToolCall(
      insertCall({ quote: "前二項による解除は、", blocks: [{ type: "body", text: "第14条" }] }),
      DEFAULT_SETTINGS,
      new AbortController().signal
    );
    expect(insertDraftParagraphs.mock.calls[0][2]).toBe("前二項による解除は、");
    expect(result.content).toContain("引用した段落の後ろ");
  });
});

describe("search_index", () => {
  it("forwards folder prefixes to Argos", async () => {
    vi.mocked(searchArgosIndex).mockResolvedValue([
      { title: "契約.md", url: "C:\\案件A\\契約.md", content: "民法第555条" },
    ]);
    const signal = new AbortController().signal;
    const result = await executeToolCall(
      {
        id: "c1",
        type: "function",
        function: { name: "search_index", arguments: '{"q":"民法 555条"}' },
      },
      { ...DEFAULT_SETTINGS, argosBaseUrl: "http://127.0.0.1:17890" },
      signal,
      { argosPathPrefixes: ["C:\\案件A"] }
    );
    expect(searchArgosIndex).toHaveBeenCalledWith(
      {
        argosBaseUrl: "http://127.0.0.1:17890",
        argosApiKey: "",
        q: "民法 555条",
        pathPrefixes: ["C:\\案件A"],
      },
      signal
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.content)[0].url).toBe("C:\\案件A\\契約.md");
  });
});

describe("foreign Han in tool arguments", () => {
  beforeEach(() => {
    insertDraftParagraphs.mockReset();
    insertDraftParagraphs.mockResolvedValue(undefined);
    replaceSelection.mockReset();
    insertComment.mockReset();
    insertCitationText.mockReset();
    beginToolTurn();
  });

  it("refuses insert_blocks that mix simplified Chinese and does not count the attempt", async () => {
    const signal = new AbortController().signal;
    const rejected = await executeToolCall(
      insertCall({ blocks: [{ type: "body", text: "这个条款。" }] }),
      DEFAULT_SETTINGS,
      signal
    );
    expect(rejected.ok).toBe(false);
    expect(rejected.content).toContain("这");
    expect(insertDraftParagraphs).not.toHaveBeenCalled();

    await executeToolCall(
      insertCall({ blocks: [{ type: "body", text: "この条項。" }] }, "c2"),
      DEFAULT_SETTINGS,
      signal
    );
    expect(insertDraftParagraphs).toHaveBeenCalledTimes(1);
    expect(insertDraftParagraphs.mock.calls[0][1]).toBe("cursor");
  });

  it("refuses replace_selection and comments with foreign Han", async () => {
    const signal = new AbortController().signal;
    const replaced = await executeToolCall(
      {
        id: "c1",
        type: "function" as const,
        function: { name: "replace_selection", arguments: '{"text":"这个。"}' },
      },
      DEFAULT_SETTINGS,
      signal
    );
    expect(replaced.ok).toBe(false);
    expect(replaceSelection).not.toHaveBeenCalled();

    const commented = await executeToolCall(
      {
        id: "c2",
        type: "function" as const,
        function: {
          name: "insert_comment",
          arguments: JSON.stringify({
            comment: "这里有问题。",
            quote: "第1条",
            severity: "medium",
          }),
        },
      },
      DEFAULT_SETTINGS,
      signal
    );
    expect(commented.ok).toBe(false);
    expect(insertComment).not.toHaveBeenCalled();
  });

  it("does not scan citation titles copied from search", async () => {
    insertCitationText.mockResolvedValue(undefined);
    const result = await executeToolCall(
      {
        id: "c1",
        type: "function" as const,
        function: {
          name: "insert_citation",
          arguments: JSON.stringify({
            title: "判决书",
            url: "http://example.test",
            snippet: "这个",
            as: "text",
          }),
        },
      },
      DEFAULT_SETTINGS,
      new AbortController().signal
    );
    expect(result.ok).toBe(true);
    expect(insertCitationText).toHaveBeenCalled();
  });
});
