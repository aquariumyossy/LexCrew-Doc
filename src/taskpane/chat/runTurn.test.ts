import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Attachment,
  ChangeNote,
  CommentNote,
  EMPTY_ATTACHMENT,
  emptyMarkup,
} from "../../shared/attachment";
import { CommittedFile } from "../../shared/fileSource";
import { NewMessage } from "../../shared/history";
import { ChatMessage } from "../../sidecar/types";
import { MAX_TOOL_ROUNDS, UNLIMITED_TOOL_ROUNDS, toolRoundLimitNotice } from "../../shared/tools";
import { DEFAULT_SETTINGS } from "../settings";
import { runTurn } from "./runTurn";

const chatStream = vi.hoisted(() => vi.fn());
const executeToolCall = vi.hoisted(() => vi.fn());

vi.mock("../api", () => ({ chatStream }));
vi.mock("./execute", () => ({ executeToolCall, beginToolTurn: vi.fn() }));

type ChatBody = { messages: ChatMessage[]; tools?: unknown[] };

function completion(partial: Partial<Awaited<ReturnType<typeof chatStream>>> = {}) {
  return {
    content: "",
    reasoningContent: "",
    toolCalls: [],
    finishReason: "stop",
    usage: null,
    ...partial,
  };
}

function toolCall(id: string, name: string, args = "{}") {
  return { id, type: "function" as const, function: { name, arguments: args } };
}

const settings = {
  ...DEFAULT_SETTINGS,
  llmBaseUrl: "http://x/v1",
  llmApiKey: "k",
  searxngUrl: "http://s",
};

function attach(focus = "", body = ""): Attachment {
  return {
    ...EMPTY_ATTACHMENT,
    scope: body ? "document" : focus ? "selection" : "none",
    document: body,
    paragraphs: body ? body.split("\n").length : 0,
    focus,
  };
}

function toolNames(callIndex = 0): string[] {
  const tools = (chatStream.mock.calls[callIndex][0] as ChatBody).tools as {
    function: { name: string };
  }[];
  return tools.map((tool) => tool.function.name);
}

async function run(instruction: string, selection = "") {
  const sent: NewMessage[] = [];
  const result = await runTurn({
    settings,
    instruction,
    attachment: attach(selection),
    history: [],
    signal: new AbortController().signal,
    onMessage: (message) => {
      sent.push(message);
    },
  });
  return { sent, result };
}

beforeEach(() => {
  chatStream.mockReset();
  executeToolCall.mockReset();
  executeToolCall.mockResolvedValue({ content: "完了", ok: true });
  chatStream.mockImplementation(
    async (
      _body,
      opts?: { onDelta?: (s: { content: string; reasoningContent: string }) => void }
    ) => {
      const result = completion({ content: "はい。" });
      opts?.onDelta?.({ content: result.content, reasoningContent: result.reasoningContent });
      return result;
    }
  );
});

describe("runTurn", () => {
  it("attaches the selection to the user message and reports usage", async () => {
    chatStream.mockResolvedValue(
      completion({
        content: "整えました。",
        usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60, reasoningTokens: 4 },
      })
    );

    const { sent, result } = await run("整えて", "甲は乙に委託する。");

    expect(sent[0].role).toBe("user");
    expect(sent[0].content).toContain("整えて");
    expect(sent[0].content).toContain("甲は乙に委託する。");
    expect(sent[1]).toMatchObject({ role: "assistant", content: "整えました。" });
    expect(result.usage?.totalTokens).toBe(60);
    expect(chatStream).toHaveBeenCalledTimes(1);
  });

  it("omits the selection block when nothing is selected", async () => {
    chatStream.mockResolvedValue(completion({ content: "はい。" }));
    const { sent } = await run("契約の骨子を作って");
    expect(sent[0].content).toBe("契約の骨子を作って");
  });

  it("sends the whole body, marked off from the instruction", async () => {
    chatStream.mockResolvedValue(completion({ content: "読みました。" }));
    await runTurn({
      settings,
      instruction: "全体を点検して",
      attachment: attach("第2条（報酬）", "第1条（目的）\n第2条（報酬）"),
      history: [],
      signal: new AbortController().signal,
      onMessage: () => undefined,
    });

    const user = (chatStream.mock.calls[0][0] as ChatBody).messages.at(-1);
    expect(user?.content).toContain("--- 文書全体 ---");
    expect(user?.content).toContain("第1条（目的）");
    expect(user?.content).toContain("--- 選択範囲 ---");
  });

  it("stores a note instead of the body, since the body is read again next turn", async () => {
    chatStream.mockResolvedValue(completion({ content: "読みました。" }));
    const sent: NewMessage[] = [];
    await runTurn({
      settings,
      instruction: "全体を点検して",
      attachment: attach("", "第1条（目的）\n第2条（報酬）"),
      history: [],
      signal: new AbortController().signal,
      onMessage: (message) => {
        sent.push(message);
      },
    });

    expect(sent[0].content).toContain("2 段落");
    expect(sent[0].content).not.toContain("第1条（目的）");
  });

  it("holds back the selection tools when nothing is selected", async () => {
    chatStream.mockResolvedValue(completion({ content: "はい。" }));
    await run("第3条を短くして");

    const names = toolNames();
    expect(names).not.toContain("get_selection");
    expect(names).not.toContain("replace_selection");
    // The way to point at text without a selection.
    expect(names).toContain("replace_quote");
    expect(names).toContain("format_list");
  });

  it("explains Word list marks only when the attachment carried them", async () => {
    chatStream.mockResolvedValue(completion({ content: "はい。" }));
    await runTurn({
      settings,
      instruction: "項を見て",
      attachment: { ...attach("", "[1] 〔1.〕甲は乙に委託する。"), listMarks: true },
      history: [],
      signal: new AbortController().signal,
      onMessage: () => undefined,
    });
    const marked = (chatStream.mock.calls[0][0] as ChatBody).messages[0]?.content || "";
    expect(marked).toContain("Word の項番号");

    chatStream.mockClear();
    chatStream.mockResolvedValue(completion({ content: "はい。" }));
    await runTurn({
      settings,
      instruction: "本文を見て",
      attachment: attach("", "[1] 甲は乙に委託する。"),
      history: [],
      signal: new AbortController().signal,
      onMessage: () => undefined,
    });
    const plain = (chatStream.mock.calls[0][0] as ChatBody).messages[0]?.content || "";
    expect(plain).not.toContain("Word の項番号");
  });

  it("requires a quote from the comment tool when there is no selection to fall back on", async () => {
    chatStream.mockResolvedValue(completion({ content: "はい。" }));
    await run("点検して");

    const tools = (chatStream.mock.calls[0][0] as ChatBody).tools as {
      function: { name: string; parameters: { required?: string[] } };
    }[];
    const comment = tools.find((tool) => tool.function.name === "insert_comment");
    expect(comment?.function.parameters.required).toEqual(["comment", "quote"]);
  });

  it("offers the selection tools once something is selected", async () => {
    chatStream.mockResolvedValue(completion({ content: "はい。" }));
    await run("これを短くして", "甲は乙に委託する。");

    const names = toolNames();
    expect(names).toContain("get_selection");
    expect(names).toContain("replace_selection");
  });

  it("keeps thinking unchanged until format thinking is set", async () => {
    chatStream.mockResolvedValue(completion({ content: "太字にしました。" }));
    await run("見出しを太字にして");
    expect((chatStream.mock.calls[0][0] as { thinkingLevel: string }).thinkingLevel).toBe("medium");
  });

  it("lowers thinking for a formatting instruction, and keeps one level through the turn", async () => {
    chatStream.mockResolvedValue(completion({ content: "太字にしました。" }));
    await runTurn({
      settings: { ...settings, formatThinkingLevel: "off" },
      instruction: "見出しを太字にして",
      attachment: attach(""),
      history: [],
      signal: new AbortController().signal,
      onMessage: () => undefined,
    });
    expect((chatStream.mock.calls[0][0] as { thinkingLevel: string }).thinkingLevel).toBe("off");

    chatStream.mockReset();
    chatStream
      .mockResolvedValueOnce(
        completion({
          toolCalls: [toolCall("c1", "format_text", '{"bold":true}')],
          finishReason: "tool_calls",
          usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14, reasoningTokens: 0 },
        })
      )
      .mockResolvedValueOnce(
        completion({
          content: "太字にしました。",
          usage: { promptTokens: 20, completionTokens: 6, totalTokens: 26, reasoningTokens: 0 },
        })
      );
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let logged: unknown[] | undefined;
    try {
      await runTurn({
        settings: { ...settings, formatThinkingLevel: "low" },
        instruction: "本文を整えて",
        attachment: attach("本文"),
        history: [],
        signal: new AbortController().signal,
        onMessage: () => undefined,
      });
      expect((chatStream.mock.calls[0][0] as { thinkingLevel: string }).thinkingLevel).toBe(
        "medium"
      );
      expect((chatStream.mock.calls[1][0] as { thinkingLevel: string }).thinkingLevel).toBe(
        "medium"
      );
      logged = info.mock.calls.find((call) => call[1] === "turn");
    } finally {
      info.mockRestore();
    }
    expect(logged?.[2]).toMatchObject({
      toolRounds: 1,
      llmCalls: 2,
      promptTokens: 30,
      completionTokens: 10,
      totalTokens: 40,
    });
  });

  it("cuts a call whose thinking runs past the budget and sends it again without thinking", async () => {
    const budget = 100;
    chatStream.mockReset();
    chatStream
      .mockImplementationOnce(
        async (
          _body,
          opts: {
            signal: AbortSignal;
            onDelta: (s: { content: string; reasoningContent: string }) => void;
          }
        ) => {
          opts.onDelta({ content: "", reasoningContent: "考".repeat(budget) });
          expect(opts.signal.aborted).toBe(false);
          opts.onDelta({ content: "", reasoningContent: "考".repeat(budget * 2) });
          opts.signal.throwIfAborted();
          return completion({ content: "届かない" });
        }
      )
      .mockResolvedValueOnce(
        completion({ toolCalls: [toolCall("c1", "search", '{"q":"民法"}')], finishReason: "tool_calls" })
      )
      .mockResolvedValueOnce(completion({ content: "調べました。" }));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sent: NewMessage[] = [];
    try {
      await runTurn({
        settings: { ...settings, thinkingBudget: budget },
        instruction: "調べて",
        attachment: attach(""),
        history: [],
        signal: new AbortController().signal,
        onMessage: (message) => {
          sent.push(message);
        },
      });
    } finally {
      info.mockRestore();
    }
    const levels = chatStream.mock.calls.map((call) => (call[0] as { thinkingLevel: string }).thinkingLevel);
    expect(levels).toEqual(["medium", "off", "medium"]);
    expect(sent.some((message) => message.content === "届かない")).toBe(false);
    expect(sent.at(-1)).toMatchObject({ role: "assistant", content: "調べました。" });
  });

  it("does not resend when the user stops a long thought", async () => {
    const controller = new AbortController();
    chatStream.mockReset();
    chatStream.mockImplementationOnce(
      async (
        _body,
        opts: {
          signal: AbortSignal;
          onDelta: (s: { content: string; reasoningContent: string }) => void;
        }
      ) => {
        controller.abort();
        opts.onDelta({ content: "", reasoningContent: "考".repeat(100_000) });
        opts.signal.throwIfAborted();
        return completion({ content: "届かない" });
      }
    );
    await expect(
      runTurn({
        settings,
        instruction: "調べて",
        attachment: attach(""),
        history: [],
        signal: controller.signal,
        onMessage: () => undefined,
      })
    ).rejects.toThrow();
    expect(chatStream).toHaveBeenCalledTimes(1);
  });

  it("runs tool calls, feeds the results back, then answers", async () => {
    chatStream
      .mockResolvedValueOnce(
        completion({
          reasoningContent: "どこを直すか考える",
          toolCalls: [toolCall("c1", "insert_comment"), toolCall("c2", "insert_comment")],
          finishReason: "tool_calls",
        })
      )
      .mockResolvedValueOnce(completion({ content: "コメントを 2 件付けました。" }));

    const { sent } = await run("点検して", "本文");

    expect(executeToolCall).toHaveBeenCalledTimes(2);
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "assistant"]);
    expect(sent[1].reasoningContent).toBe("どこを直すか考える");
    expect(sent[2].toolCallId).toBe("c1");

    const second = chatStream.mock.calls[1][0] as ChatBody;
    const assistantTurn = second.messages.find((m) => m.role === "assistant");
    expect(assistantTurn?.tool_calls).toHaveLength(2);
    // Qwen wants its own reasoning back alongside the tool replies.
    expect(assistantTurn?.reasoning_content).toBe("どこを直すか考える");
    expect(second.messages.filter((m) => m.role === "tool")).toHaveLength(2);
  });

  it("offers paragraph numbers from the next round once an insert handed some out", async () => {
    executeToolCall.mockResolvedValue({ content: "3 段落を挿入しました。\n[2] 第1条", ok: true, numbered: true });
    chatStream
      .mockResolvedValueOnce(
        completion({ toolCalls: [toolCall("c1", "insert_blocks")], finishReason: "tool_calls" })
      )
      .mockResolvedValueOnce(completion({ content: "入れました。" }));

    // An empty document: the first round has no numbers to offer.
    await run("ひな形を入れて");

    const properties = (callIndex: number) =>
      ((chatStream.mock.calls[callIndex][0] as ChatBody).tools as {
        function: { name: string; parameters: { properties: Record<string, unknown> } };
      }[]).find((tool) => tool.function.name === "format_list")?.function.parameters.properties;
    expect(properties(0)?.paragraph).toBeUndefined();
    expect(properties(1)?.paragraph).toBeDefined();
  });

  it("offers paragraph numbers from the next round once a read handed some out", async () => {
    executeToolCall.mockResolvedValue({
      content: "[1] 番号なし\n前文",
      ok: true,
      numbered: true,
    });
    chatStream
      .mockResolvedValueOnce(
        completion({ toolCalls: [toolCall("c1", "read_paragraphs")], finishReason: "tool_calls" })
      )
      .mockResolvedValueOnce(completion({ content: "読みました。" }));

    await run("ひな形を見て");

    const properties = (callIndex: number) =>
      ((chatStream.mock.calls[callIndex][0] as ChatBody).tools as {
        function: { name: string; parameters: { properties: Record<string, unknown> } };
      }[]).find((tool) => tool.function.name === "format_list")?.function.parameters.properties;
    expect(properties(0)?.paragraph).toBeUndefined();
    expect(properties(1)?.paragraph).toBeDefined();
  });

  it("stops after the tool-round budget and tells the user, without a no-tools closing call", async () => {
    chatStream.mockResolvedValue(
      completion({ toolCalls: [toolCall("c1", "insert_comment")], finishReason: "tool_calls" })
    );

    const { sent } = await run("延々と調べて");

    expect(chatStream).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS);
    expect((chatStream.mock.calls[MAX_TOOL_ROUNDS - 1][0] as ChatBody).tools).toBeDefined();
    const assistants = sent.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(MAX_TOOL_ROUNDS + 1);
    expect(assistants.at(-1)?.content).toBe(toolRoundLimitNotice(MAX_TOOL_ROUNDS));
  });

  it("honours a lower tool-round cap from settings", async () => {
    chatStream.mockResolvedValue(
      completion({ toolCalls: [toolCall("c1", "insert_comment")], finishReason: "tool_calls" })
    );

    const sent: NewMessage[] = [];
    await runTurn({
      settings: { ...settings, maxToolRounds: 2 },
      instruction: "点検して",
      attachment: EMPTY_ATTACHMENT,
      history: [],
      signal: new AbortController().signal,
      onMessage: (message) => {
        sent.push(message);
      },
    });

    expect(chatStream).toHaveBeenCalledTimes(2);
    expect(sent.filter((m) => m.role === "assistant").at(-1)?.content).toBe(
      toolRoundLimitNotice(2)
    );
  });

  it("keeps tools when the round cap is unlimited", async () => {
    chatStream
      .mockResolvedValueOnce(
        completion({ toolCalls: [toolCall("c1", "insert_comment")], finishReason: "tool_calls" })
      )
      .mockResolvedValueOnce(
        completion({ toolCalls: [toolCall("c2", "insert_comment")], finishReason: "tool_calls" })
      )
      .mockResolvedValueOnce(
        completion({ toolCalls: [toolCall("c3", "insert_comment")], finishReason: "tool_calls" })
      )
      .mockResolvedValueOnce(completion({ content: "コメントを付けました。" }));

    const sent: NewMessage[] = [];
    await runTurn({
      settings: { ...settings, maxToolRounds: UNLIMITED_TOOL_ROUNDS },
      instruction: "点検して",
      attachment: attach("本文"),
      history: [],
      signal: new AbortController().signal,
      onMessage: (message) => {
        sent.push(message);
      },
    });

    expect(chatStream).toHaveBeenCalledTimes(4);
    expect(chatStream.mock.calls.every((call) => (call[0] as ChatBody).tools)).toBe(true);
    expect(sent.filter((m) => m.role === "assistant").at(-1)?.content).toBe(
      "コメントを付けました。"
    );
    expect(sent.some((m) => m.content.includes("上限"))).toBe(false);
  });

  it("retries once without tools when the server rejects them", async () => {
    chatStream
      .mockRejectedValueOnce(new Error("MTPLX が 400 を返しました。tools is not supported"))
      .mockResolvedValueOnce(completion({ content: "ツール無しで答えます。" }));

    const { sent } = await run("点検して");

    expect(chatStream).toHaveBeenCalledTimes(2);
    expect((chatStream.mock.calls[1][0] as ChatBody).tools).toBeUndefined();
    expect(sent[1].content).toBe("ツール無しで答えます。");
  });

  it("passes other failures through", async () => {
    chatStream.mockRejectedValue(new Error("MTPLX に接続できませんでした。"));
    await expect(run("点検して")).rejects.toThrow(/接続できません/);
  });

  it("does not offer search tools when both providers are unset", async () => {
    chatStream.mockResolvedValue(completion({ content: "はい。" }));
    await runTurn({
      settings: { ...settings, searxngUrl: "", argosBaseUrl: "" },
      instruction: "調べて",
      attachment: EMPTY_ATTACHMENT,
      history: [],
      signal: new AbortController().signal,
      onMessage: () => undefined,
    });

    const names = toolNames();
    expect(names).not.toContain("search");
    expect(names).not.toContain("search_index");
    expect(names).not.toContain("insert_citation");
  });

  it("offers search_index and keeps the selected folders in the system prompt", async () => {
    chatStream
      .mockResolvedValueOnce(
        completion({
          toolCalls: [toolCall("c1", "search_index", '{"q":"民法"}')],
          finishReason: "tool_calls",
        })
      )
      .mockResolvedValueOnce(completion({ content: "見つかりました。" }));

    await runTurn({
      settings: { ...settings, searxngUrl: "", argosBaseUrl: "http://127.0.0.1:17890" },
      instruction: "契約を探して",
      attachment: EMPTY_ATTACHMENT,
      history: [],
      signal: new AbortController().signal,
      onMessage: () => undefined,
      argosPathPrefixes: ["C:\\案件A"],
    });

    const first = chatStream.mock.calls[0][0] as ChatBody;
    const names = toolNames();
    expect(names).toContain("search_index");
    expect(names).toContain("read_indexed_file");
    expect(names).not.toContain("search");
    expect(first.messages[0].content).toContain("C:\\案件A");
    expect(executeToolCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ argosPathPrefixes: ["C:\\案件A"], indexedReadChars: 52422 })
    );
  });

  it("clears then reports live deltas for the current round", async () => {
    const deltas: { content: string; reasoningContent: string }[] = [];
    chatStream.mockImplementation(
      async (
        _body,
        opts?: { onDelta?: (s: { content: string; reasoningContent: string }) => void }
      ) => {
        opts?.onDelta?.({ content: "こ", reasoningContent: "考" });
        opts?.onDelta?.({ content: "こんにちは", reasoningContent: "考える" });
        return completion({ content: "こんにちは", reasoningContent: "考える" });
      }
    );
    await runTurn({
      settings,
      instruction: "挨拶して",
      attachment: EMPTY_ATTACHMENT,
      history: [],
      signal: new AbortController().signal,
      onMessage: () => undefined,
      onDelta: (snapshot) => deltas.push(snapshot),
    });
    expect(deltas[0]).toEqual({ content: "", reasoningContent: "" });
    expect(deltas.at(-1)).toEqual({ content: "こんにちは", reasoningContent: "考える" });
  });
});

function attachedFile(name: string, body: string): CommittedFile {
  return {
    id: name,
    name,
    origin: "text",
    body,
    comments: emptyMarkup<CommentNote>(),
    changes: emptyMarkup<ChangeNote>(),
    truncated: false,
    size: body.length,
    mtime: 1,
  };
}

describe("runTurn with attached files", () => {
  async function runWithFiles(files: CommittedFile[], over: Partial<typeof settings> = {}) {
    const sent: NewMessage[] = [];
    await runTurn({
      settings: { ...settings, ...over },
      instruction: "この資料を読んで",
      attachment: EMPTY_ATTACHMENT,
      files,
      history: [],
      signal: new AbortController().signal,
      onMessage: (message) => {
        sent.push(message);
      },
    });
    return { sent, body: chatStream.mock.calls[0][0] as ChatBody };
  }

  it("sends the text to the model and only a stub to the transcript", async () => {
    const { sent, body } = await runWithFiles([attachedFile("覚書.pdf", "第1条 本覚書は…")]);
    const asked = body.messages.at(-1)?.content || "";
    expect(asked).toContain("第1条 本覚書は…");
    expect(sent[0].content).toContain("覚書.pdf");
    expect(sent[0].content).not.toContain("第1条 本覚書は…");
  });

  it("explains how to treat the material only when some rode along", async () => {
    const { body } = await runWithFiles([attachedFile("覚書.pdf", "本文")]);
    expect(body.messages[0].content).toContain("--- 添付ファイル ---");

    chatStream.mockClear();
    const bare = await runWithFiles([]);
    expect(bare.body.messages[0].content).not.toContain("--- 添付ファイル ---");
    expect(bare.sent[0].content).toBe("この資料を読んで");
  });

  /*
   * The files sit in the current message, which `dropOldest` never drops, so a
   * window too narrow to hold them has to be handled before the request goes.
   */
  it("cuts the text to the window rather than sending it over the limit", async () => {
    const long = attachedFile("長い.txt", "あ".repeat(50_000));
    const { sent, body } = await runWithFiles([long], { contextLimit: 4_096 });
    const asked = body.messages.at(-1)?.content || "";
    expect(asked.length).toBeLessThan(6_000);
    expect(asked).toContain("--- 添付ファイル ---");
    // The transcript records what actually rode along, not what was read.
    expect(sent[0].content).toContain("長いので途中まで");
  });

  it("shares a tight budget between files instead of starving the later ones", async () => {
    const { body } = await runWithFiles(
      [attachedFile("小.txt", "い".repeat(50)), attachedFile("大.txt", "う".repeat(50_000))],
      { contextLimit: 4_096 }
    );
    const asked = body.messages.at(-1)?.content || "";
    expect(asked).toContain("[1] 小.txt");
    expect(asked).toContain("[2] 大.txt");
    expect(asked).toContain("い".repeat(50));
  });
});
