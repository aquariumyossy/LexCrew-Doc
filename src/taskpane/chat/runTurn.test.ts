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
import {
  THINKING_BRIDGE,
  THINKING_BUDGET_UNSET_NOTICE,
  runawayThinkingChars,
} from "../../shared/thinking";
import { StoredMessage } from "../../shared/history";
import { forgetThinkingBudget } from "./thinkingBudget";
import { EDIT_DECLINED_TOOL_RESULT } from "../../shared/questionTurn";
import { ABORTED_TOOL_RESULT } from "./context";
import {
  MAX_TOOL_ROUNDS,
  TOOL_FORMAT_TEXT,
  TOOL_READ_PARAGRAPHS,
  TOOL_SET_OUTLINE,
  UNLIMITED_TOOL_ROUNDS,
  toolRoundLimitNotice,
} from "../../shared/tools";
import { DEFAULT_SETTINGS } from "../settings";
import { runTurn } from "./runTurn";

const chatStream = vi.hoisted(() => vi.fn());
const fetchThinkingBudget = vi.hoisted(() => vi.fn());
const executeToolCall = vi.hoisted(() => vi.fn());

vi.mock("../api", () => ({ chatStream, fetchThinkingBudget }));
vi.mock("./execute", () => ({ executeToolCall, beginToolTurn: vi.fn() }));

type ChatBody = { messages: ChatMessage[]; tools?: unknown[] };
type StreamOptions = {
  signal: AbortSignal;
  onDelta?: (s: { content: string; reasoningContent: string }) => void;
};

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
  fetchThinkingBudget.mockReset();
  fetchThinkingBudget.mockResolvedValue(undefined);
  forgetThinkingBudget();
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

    const messages = (chatStream.mock.calls[0][0] as ChatBody).messages;
    const user = messages.at(-1);
    expect(user?.role).toBe("user");
    expect(user?.content).toContain("--- 文書全体 ---");
    expect(user?.content).toContain("第1条（目的）");
    expect(user?.content).toContain("--- 選択範囲 ---");
    expect(user?.content?.endsWith("全体を点検して")).toBe(true);
    expect(user?.content?.indexOf("--- 文書全体 ---")).toBeLessThan(
      user?.content?.lastIndexOf("全体を点検して") ?? 0
    );
    expect(messages[0].content).not.toContain("第1条（目的）");
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
    const markedMessages = (chatStream.mock.calls[0][0] as ChatBody).messages;
    const marked = markedMessages.at(-1)?.content || "";
    expect(marked).toContain("Word の項番号");
    expect(markedMessages[0].content).not.toContain("Word の項番号");

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
    const plainMessages = (chatStream.mock.calls[0][0] as ChatBody).messages;
    expect(plainMessages.at(-1)?.content || "").not.toContain("Word の項番号");
    expect(plainMessages[0].content).not.toContain("Word の項番号");
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

  it("leaves the thinking strength to MTPLX, formatting included", async () => {
    chatStream.mockResolvedValue(completion({ content: "太字にしました。" }));
    await run("見出しを太字にして");
    expect(chatStream.mock.calls[0][0]).not.toHaveProperty("thinkingLevel");
  });

  it("logs the calls and tokens of the turn", async () => {
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
        settings,
        instruction: "本文を整えて",
        attachment: attach("本文"),
        history: [],
        signal: new AbortController().signal,
        onMessage: () => undefined,
      });
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

  it("stops the turn when thinking runs past the runaway limit, without sending it again", async () => {
    const limit = runawayThinkingChars(null);
    chatStream.mockReset();
    chatStream.mockImplementation(async (_body: unknown, opts: StreamOptions) => {
      opts.onDelta?.({ content: "", reasoningContent: "考".repeat(limit) });
      expect(opts.signal.aborted).toBe(false);
      opts.onDelta?.({ content: "", reasoningContent: "考".repeat(limit + 1) });
      opts.signal.throwIfAborted();
      return completion({ content: "届かない" });
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sent: NewMessage[] = [];
    try {
      await expect(
        runTurn({
          settings,
          instruction: "調べて",
          attachment: attach(""),
          history: [],
          signal: new AbortController().signal,
          onMessage: (message) => {
            sent.push(message);
          },
        })
      ).rejects.toThrow(
        `思考が ${limit + 1} 字に達しても答えが出ないため止めました。` +
          "MTPLX に思考の上限が設定されているか確かめ、指示を分けて送り直してください。"
      );
    } finally {
      info.mockRestore();
    }
    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(sent.some((message) => message.content === "届かない")).toBe(false);
  });

  it("stops a call whose answer repeats the MTPLX bridge and sends it once more", async () => {
    const leaked = `<\n\n${THINKING_BRIDGE}\n<\n\n${THINKING_BRIDGE}\n<`;
    chatStream.mockReset();
    chatStream
      .mockImplementationOnce(async (_body: unknown, opts: StreamOptions) => {
        opts.onDelta?.({ content: "<", reasoningContent: `考えた。\n\n${THINKING_BRIDGE}\n` });
        expect(opts.signal.aborted).toBe(false);
        opts.onDelta?.({ content: leaked, reasoningContent: `考えた。\n\n${THINKING_BRIDGE}\n` });
        opts.signal.throwIfAborted();
        return completion({ content: leaked });
      })
      .mockResolvedValueOnce(completion({ content: "置き換えました。" }));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let sent: NewMessage[] = [];
    try {
      ({ sent } = await run("書き直して"));
    } finally {
      info.mockRestore();
    }
    expect(chatStream).toHaveBeenCalledTimes(2);
    expect(sent.some((message) => message.content.includes(THINKING_BRIDGE))).toBe(false);
    expect(sent.at(-1)).toMatchObject({ role: "assistant", content: "置き換えました。" });
  });

  it("stops the turn when the resent call repeats the MTPLX bridge again", async () => {
    chatStream.mockReset();
    chatStream.mockImplementation(async (_body: unknown, opts: StreamOptions) => {
      opts.onDelta?.({ content: `<\n\n${THINKING_BRIDGE}\n<`, reasoningContent: "考えた。" });
      opts.signal.throwIfAborted();
      return completion({ content: "届かない" });
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await expect(run("書き直して")).rejects.toThrow(
        "MTPLX が思考を閉じられず、同じ文を繰り返したため止めました。"
      );
    } finally {
      info.mockRestore();
    }
    expect(chatStream).toHaveBeenCalledTimes(2);
  });

  it("reads the MTPLX budget after the first call and stops thinking that runs past it", async () => {
    const limit = runawayThinkingChars(100);
    fetchThinkingBudget.mockResolvedValue(100);
    chatStream.mockReset();
    chatStream
      .mockResolvedValueOnce(
        completion({
          toolCalls: [toolCall("c1", "search", '{"q":"民法"}')],
          finishReason: "tool_calls",
          requestId: "chatcmpl-1",
        })
      )
      .mockImplementationOnce(async (_body: unknown, opts: StreamOptions) => {
        opts.onDelta?.({ content: "", reasoningContent: "考".repeat(limit + 1) });
        opts.signal.throwIfAborted();
        return completion({ content: "届かない" });
      });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await expect(run("調べて")).rejects.toThrow(`思考が ${limit + 1} 字に達しても`);
    } finally {
      info.mockRestore();
    }
    expect(fetchThinkingBudget).toHaveBeenCalledTimes(1);
    expect(fetchThinkingBudget.mock.calls[0][0]).toEqual({
      llmBaseUrl: settings.llmBaseUrl,
      llmApiKey: settings.llmApiKey,
      requestId: "chatcmpl-1",
    });
  });

  it("tells the conversation once that MTPLX has no thinking budget", async () => {
    fetchThinkingBudget.mockResolvedValue(null);
    chatStream.mockResolvedValue(completion({ content: "答えました。", requestId: "chatcmpl-1" }));
    const { sent } = await run("調べて");
    expect(sent.map((message) => message.content).slice(-2)).toEqual([
      "答えました。",
      THINKING_BUDGET_UNSET_NOTICE,
    ]);

    const told: StoredMessage = {
      id: 1,
      role: "assistant",
      content: THINKING_BUDGET_UNSET_NOTICE,
      reasoningContent: "",
      toolCalls: [],
      toolCallId: "",
      usage: null,
      createdAt: "",
    };
    const again: NewMessage[] = [];
    await runTurn({
      settings,
      instruction: "続けて",
      attachment: attach(""),
      history: [told],
      signal: new AbortController().signal,
      onMessage: (message) => {
        again.push(message);
      },
    });
    expect(again.at(-1)).toMatchObject({ role: "assistant", content: "答えました。" });
  });

  it("says so when the model ends with neither text nor a tool call", async () => {
    chatStream.mockReset();
    chatStream.mockResolvedValue(completion({ content: "", finishReason: "stop" }));
    const { sent } = await run("書き直して");
    expect(sent.at(-1)).toEqual({
      role: "assistant",
      content:
        "モデルが本文も操作も返さずに終わりました（終了理由: stop）。もう一度送るか、指示を分けてください。",
    });
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

describe("question turn edit guard", () => {
  it("runs an edit on a normal instruction without asking", async () => {
    const confirm = vi.fn(async () => "allow" as const);
    chatStream
      .mockResolvedValueOnce(
        completion({
          toolCalls: [toolCall("c1", TOOL_FORMAT_TEXT, '{"bold":true}')],
          finishReason: "tool_calls",
        })
      )
      .mockResolvedValueOnce(completion({ content: "直しました。" }));
    await runTurn({
      settings,
      instruction: "見出しを直して",
      attachment: attach(""),
      history: [],
      signal: new AbortController().signal,
      onMessage: () => undefined,
      confirmDocumentEdit: confirm,
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(executeToolCall).toHaveBeenCalledTimes(1);
  });

  it("does not gate a read on a question", async () => {
    const confirm = vi.fn(async () => "decline" as const);
    chatStream
      .mockResolvedValueOnce(
        completion({
          toolCalls: [toolCall("c1", TOOL_READ_PARAGRAPHS, '{"from":1}')],
          finishReason: "tool_calls",
        })
      )
      .mockResolvedValueOnce(completion({ content: "第1条は委託です。" }));
    await runTurn({
      settings,
      instruction: "なぜこの条なの？",
      attachment: attach(""),
      history: [],
      signal: new AbortController().signal,
      onMessage: () => undefined,
      confirmDocumentEdit: confirm,
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(executeToolCall.mock.calls[0][0].function.name).toBe(TOOL_READ_PARAGRAPHS);
  });

  it("decline skips the edit and continues with no tools at all", async () => {
    const confirm = vi.fn(async () => "decline" as const);
    chatStream
      .mockResolvedValueOnce(
        completion({
          toolCalls: [
            toolCall("c1", TOOL_READ_PARAGRAPHS, '{"from":1}'),
            toolCall("c2", TOOL_SET_OUTLINE, '{"level":1}'),
          ],
          finishReason: "tool_calls",
        })
      )
      .mockResolvedValueOnce(completion({ content: "チャットで答えます。" }));
    const sent: NewMessage[] = [];
    await runTurn({
      settings,
      instruction: "なぜ？\n本文は修正しないでチャットで答えて",
      attachment: attach(""),
      history: [],
      signal: new AbortController().signal,
      onMessage: (message) => {
        sent.push(message);
      },
      confirmDocumentEdit: confirm,
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(executeToolCall.mock.calls[0][0].function.name).toBe(TOOL_READ_PARAGRAPHS);
    expect(sent.some((message) => message.content === EDIT_DECLINED_TOOL_RESULT)).toBe(true);
    expect(chatStream).toHaveBeenCalledTimes(2);
    const second = chatStream.mock.calls[1][0] as ChatBody;
    expect(second.tools).toBeUndefined();
    const declined = second.messages.find((message) => message.tool_call_id === "c2");
    expect(declined?.content).toBe(EDIT_DECLINED_TOOL_RESULT);
  });

  it("allow runs every edit in the turn and does not ask again", async () => {
    const confirm = vi.fn(async () => "allow" as const);
    chatStream
      .mockResolvedValueOnce(
        completion({
          toolCalls: [
            toolCall("c1", TOOL_FORMAT_TEXT, '{"bold":true}'),
            toolCall("c2", TOOL_FORMAT_TEXT, '{"bold":true}'),
          ],
          finishReason: "tool_calls",
        })
      )
      .mockResolvedValueOnce(
        completion({
          toolCalls: [toolCall("c3", TOOL_SET_OUTLINE, '{"level":1}')],
          finishReason: "tool_calls",
        })
      )
      .mockResolvedValueOnce(completion({ content: "直しました。" }));
    await runTurn({
      settings,
      instruction: "この見出しの理由は？",
      attachment: attach(""),
      history: [],
      signal: new AbortController().signal,
      onMessage: () => undefined,
      confirmDocumentEdit: confirm,
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(executeToolCall).toHaveBeenCalledTimes(3);
    const third = chatStream.mock.calls[2][0] as ChatBody;
    const names = (third.tools as { function: { name: string } }[]).map(
      (tool) => tool.function.name
    );
    expect(names).toContain(TOOL_FORMAT_TEXT);
    expect(names).toContain(TOOL_SET_OUTLINE);
  });

  it("writes 中止しました for every unfinished tool call when confirm is aborted", async () => {
    const controller = new AbortController();
    chatStream.mockResolvedValueOnce(
      completion({
        toolCalls: [
          toolCall("c1", TOOL_READ_PARAGRAPHS, '{"from":1}'),
          toolCall("c2", TOOL_FORMAT_TEXT, '{"bold":true}'),
          toolCall("c3", TOOL_SET_OUTLINE, '{"level":1}'),
        ],
        finishReason: "tool_calls",
      })
    );
    const sent: NewMessage[] = [];
    await expect(
      runTurn({
        settings,
        instruction: "なぜこの条なの？",
        attachment: attach(""),
        history: [],
        signal: controller.signal,
        onMessage: (message) => {
          sent.push(message);
        },
        confirmDocumentEdit: () => {
          controller.abort();
          const error = new Error("中止しました。");
          error.name = "AbortError";
          return Promise.reject(error);
        },
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(executeToolCall.mock.calls[0][0].function.name).toBe(TOOL_READ_PARAGRAPHS);
    const tools = sent.filter((message) => message.role === "tool");
    expect(tools.map((message) => [message.toolCallId, message.content])).toEqual([
      ["c1", "完了"],
      ["c2", ABORTED_TOOL_RESULT],
      ["c3", ABORTED_TOOL_RESULT],
    ]);
    expect(chatStream).toHaveBeenCalledTimes(1);
  });

  it("closes every pending call when the abort happens before any tool runs", async () => {
    chatStream.mockResolvedValueOnce(
      completion({
        toolCalls: [
          toolCall("c1", TOOL_FORMAT_TEXT, '{"bold":true}'),
          toolCall("c2", TOOL_SET_OUTLINE, '{"level":1}'),
        ],
        finishReason: "tool_calls",
      })
    );
    const sent: NewMessage[] = [];
    const error = new Error("中止しました。");
    error.name = "AbortError";
    await expect(
      runTurn({
        settings,
        instruction: "なぜ？",
        attachment: attach(""),
        history: [],
        signal: new AbortController().signal,
        onMessage: (message) => {
          sent.push(message);
        },
        confirmDocumentEdit: () => Promise.reject(error),
      })
    ).rejects.toBe(error);
    expect(executeToolCall).not.toHaveBeenCalled();
    const tools = sent.filter((message) => message.role === "tool");
    expect(tools.map((message) => message.toolCallId)).toEqual(["c1", "c2"]);
    expect(tools.every((message) => message.content === ABORTED_TOOL_RESULT)).toBe(true);
  });

  it("does not invent a cancel result when a tool fails on its own", async () => {
    executeToolCall.mockRejectedValueOnce(new Error("段落を読めませんでした。"));
    chatStream.mockResolvedValueOnce(
      completion({
        toolCalls: [toolCall("c1", TOOL_FORMAT_TEXT, '{"bold":true}')],
        finishReason: "tool_calls",
      })
    );
    const sent: NewMessage[] = [];
    await expect(
      runTurn({
        settings,
        instruction: "見出しを直して",
        attachment: attach(""),
        history: [],
        signal: new AbortController().signal,
        onMessage: (message) => {
          sent.push(message);
        },
      })
    ).rejects.toThrow("段落を読めませんでした。");
    expect(sent.filter((message) => message.role === "tool")).toHaveLength(0);
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
    expect(body.messages[0].content).toContain("第1条 本覚書は…");
    expect(body.messages.at(-1)?.content).not.toContain("第1条 本覚書は…");
    expect(body.messages.at(-1)?.content?.endsWith("この資料を読んで")).toBe(true);
    expect(sent[0].content).toContain("覚書.pdf");
    expect(sent[0].content).not.toContain("第1条 本覚書は…");
    expect(sent[0].content.startsWith("この資料を読んで")).toBe(true);
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
   * The files sit in the system message, which `dropOldest` never drops, so a
   * window too narrow to hold them has to be handled before the request goes.
   */
  it("cuts the text to the window rather than sending it over the limit", async () => {
    const long = attachedFile("長い.txt", "あ".repeat(50_000));
    const { sent, body } = await runWithFiles([long], { contextLimit: 4_096 });
    const system = body.messages[0].content || "";
    expect(system).toContain("--- 添付ファイル ---");
    expect(system).not.toContain("あ".repeat(5_000));
    // The transcript records what actually rode along, not what was read.
    expect(sent[0].content).toContain("長いので途中まで");
  });

  it("shares a tight budget between files instead of starving the later ones", async () => {
    const { body } = await runWithFiles(
      [attachedFile("小.txt", "い".repeat(50)), attachedFile("大.txt", "う".repeat(50_000))],
      { contextLimit: 4_096 }
    );
    const system = body.messages[0].content || "";
    expect(system).toContain("[1] 小.txt");
    expect(system).toContain("[2] 大.txt");
    expect(system).toContain("い".repeat(50));
  });

  it("keeps the file prefix identical when only the document and the instruction change", async () => {
    const prior: StoredMessage = {
      id: 1,
      role: "user",
      content: "前に直して\n\n--- 文書全体 ---\n古い本文",
      reasoningContent: "",
      toolCalls: [],
      toolCallId: "",
      usage: null,
      createdAt: "",
    };
    const file = attachedFile("覚書.pdf", "第1条 本覚書は安定している");
    const first = await runWithFiles([file]);
    chatStream.mockClear();
    chatStream.mockResolvedValue(completion({ content: "はい。" }));
    await runTurn({
      settings,
      instruction: "なぜこの建付けなの？",
      attachment: attach("第2条", "第1条（目的）\n第2条（報酬）"),
      files: [file],
      history: [prior],
      signal: new AbortController().signal,
      onMessage: () => undefined,
    });
    const second = chatStream.mock.calls[0][0] as ChatBody;
    expect(second.messages[0].content).toBe(first.body.messages[0].content);
    expect(second.messages[0].content).toContain("第1条 本覚書は安定している");
    expect(second.messages[1]).toMatchObject({ role: "user", content: "前に直して" });
    const last = second.messages.at(-1)?.content || "";
    expect(last).toContain("--- 文書全体 ---");
    expect(last).toContain("第2条（報酬）");
    expect(last).not.toContain("--- 添付ファイル ---");
    expect(last.endsWith("なぜこの建付けなの？")).toBe(true);
    expect(last.indexOf("--- 文書全体 ---")).toBeLessThan(last.lastIndexOf("--- 指示 ---"));
  });
});
