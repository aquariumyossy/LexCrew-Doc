import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings";

const insertDraftParagraphs = vi.hoisted(() => vi.fn());
const readBuffer = vi.hoisted(() => vi.fn());
const insertBlankBefore = vi.hoisted(() => vi.fn());
const replaceSelection = vi.hoisted(() => vi.fn());
const insertComment = vi.hoisted(() => vi.fn());
const insertCitationText = vi.hoisted(() => vi.fn());
const formatList = vi.hoisted(() => vi.fn());
const setOutlineLevel = vi.hoisted(() => vi.fn());
const applyFormat = vi.hoisted(() => vi.fn());
const replaceAll = vi.hoisted(() => vi.fn());
const copyFormat = vi.hoisted(() => vi.fn());

vi.mock("../word", () => ({
  insertDraftParagraphs,
  insertBlankBefore,
  getSelectionInfo: vi.fn(),
  replaceSelection,
  replaceQuote: vi.fn(),
  insertComment,
  insertCitationComment: vi.fn(),
  insertCitationText,
  formatText: vi.fn(),
  formatParagraph: vi.fn(),
  formatList,
  setOutlineLevel,
  applyFormat,
  replaceAll,
  copyFormat,
}));

vi.mock("../api", () => ({ search: vi.fn(), searchArgosIndex: vi.fn(), readArgosFile: vi.fn() }));
vi.mock("../files/read", () => ({ readBuffer }));

import { beginToolTurn, executeToolCall } from "./execute";
import { readArgosFile, searchArgosIndex } from "../api";

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

describe("read_indexed_file", () => {
  const signal = new AbortController().signal;
  const call = {
    id: "c1",
    type: "function" as const,
    function: { name: "read_indexed_file", arguments: '{"path":"C:\\\\案件A\\\\契約.txt"}' },
  };
  const settings = { ...DEFAULT_SETTINGS, argosBaseUrl: "http://127.0.0.1:17890" };

  beforeEach(() => {
    readBuffer.mockReset();
    vi.mocked(readArgosFile).mockReset();
  });

  it("returns the extracted text within the character budget", async () => {
    vi.mocked(readArgosFile).mockResolvedValue({
      name: "契約.txt",
      bytes: new ArrayBuffer(0),
    });
    readBuffer.mockResolvedValue({
      status: "text",
      text: { body: "みなし合格とする。", truncated: false },
    });
    const result = await executeToolCall(call, settings, signal, { indexedReadChars: 1000 });
    expect(result.ok).toBe(true);
    expect(result.content).toBe("みなし合格とする。");
    expect(readBuffer).toHaveBeenCalledWith("契約.txt", expect.any(ArrayBuffer));
  });

  it("asks for an attachment when the file has no text layer", async () => {
    vi.mocked(readArgosFile).mockResolvedValue({ name: "scan.pdf", bytes: new ArrayBuffer(0) });
    readBuffer.mockResolvedValue({ status: "scan", pages: 2 });
    const result = await executeToolCall(call, settings, signal, { indexedReadChars: 1000 });
    expect(result.content).toContain("チャットに添付");
  });

  it("refuses when the tool-result share is already full", async () => {
    const result = await executeToolCall(call, settings, signal, { indexedReadChars: 0 });
    expect(result.ok).toBe(false);
    expect(readArgosFile).not.toHaveBeenCalled();
  });
});

describe("foreign Han in tool arguments", () => {
  beforeEach(() => {
    insertDraftParagraphs.mockReset();
    insertDraftParagraphs.mockResolvedValue(undefined);
    replaceSelection.mockReset();
    insertComment.mockReset();
    insertCitationText.mockReset();
    formatList.mockReset();
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

  it("runs format_list and tells the model where the number landed", async () => {
    formatList.mockResolvedValue("「甲は委託する。」を対象にしました。番号は 〔1.〕 です。");
    const result = await executeToolCall(
      {
        id: "c1",
        type: "function" as const,
        function: {
          name: "format_list",
          arguments: '{"action":"apply","paragraph":12,"style":"arabic"}',
        },
      },
      DEFAULT_SETTINGS,
      new AbortController().signal
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("リスト番号");
    expect(result.content).toContain("〔1.〕");
    expect(formatList).toHaveBeenCalledWith({
      action: "apply",
      quote: "",
      paragraph: 12,
      style: "arabic",
    });
  });

  it("returns only the count from a bulk format tool", async () => {
    applyFormat.mockResolvedValue("8 段落に書式を当てました（変更履歴に書式変更として記録）。");
    replaceAll.mockResolvedValue("3 件置換しました（変更履歴に記録）。");
    const applied = await executeToolCall(
      {
        id: "c1",
        type: "function" as const,
        function: {
          name: "apply_format",
          arguments: '{"select":{"style":"見出し 1"},"format":{"bold":true}}',
        },
      },
      DEFAULT_SETTINGS,
      new AbortController().signal
    );
    expect(applied.content).toBe("8 段落に書式を当てました（変更履歴に書式変更として記録）。");
    expect(applyFormat).toHaveBeenCalledTimes(1);

    const replaced = await executeToolCall(
      {
        id: "c2",
        type: "function" as const,
        function: { name: "replace_all", arguments: '{"find":"甲","replace":"这个"}' },
      },
      DEFAULT_SETTINGS,
      new AbortController().signal
    );
    expect(replaced.ok).toBe(false);
    expect(replaceAll).not.toHaveBeenCalled();

    copyFormat.mockResolvedValue("2 段落に書式を写しました（変更履歴に書式変更として記録）。");
    const copied = await executeToolCall(
      {
        id: "c3",
        type: "function" as const,
        function: { name: "copy_format", arguments: '{"from":1,"paragraphs":[2,3]}' },
      },
      DEFAULT_SETTINGS,
      new AbortController().signal
    );
    expect(copied.content).toContain("2 段落");
    expect(copyFormat).toHaveBeenCalledTimes(1);
  });

  it("runs set_outline_level without wrapping a second success sentence", async () => {
    setOutlineLevel.mockResolvedValue(
      "「請求の趣旨」をレベル 1 の見出しにしました（変更履歴に書式変更として記録）。"
    );
    const result = await executeToolCall(
      {
        id: "c1",
        type: "function" as const,
        function: {
          name: "set_outline_level",
          arguments: '{"action":"set","paragraph":4,"level":1}',
        },
      },
      DEFAULT_SETTINGS,
      new AbortController().signal
    );
    expect(result.ok).toBe(true);
    expect(result.content).toBe(
      "「請求の趣旨」をレベル 1 の見出しにしました（変更履歴に書式変更として記録）。"
    );
    expect(setOutlineLevel).toHaveBeenCalledWith({
      action: "set",
      quote: "",
      paragraph: 4,
      level: 1,
    });
  });

  it("inserts blank lines without handing out paragraph numbers", async () => {
    insertBlankBefore.mockReset();
    insertBlankBefore.mockResolvedValue(
      "1 箇所の直前に空行を入れました（「第1条（目的）」）。変更履歴に記録しました。"
    );
    const result = await executeToolCall(
      {
        id: "c1",
        type: "function" as const,
        function: { name: "insert_blank_before", arguments: '{"paragraphs":[4]}' },
      },
      DEFAULT_SETTINGS,
      new AbortController().signal
    );
    expect(result.ok).toBe(true);
    expect(result.numbered).toBeUndefined();
    expect(result.content).toContain("第1条（目的）");
    expect(insertBlankBefore).toHaveBeenCalledWith([4]);
  });
});
