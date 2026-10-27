import { describe, expect, it, vi } from "vitest";
import { EMPTY_ATTACHMENT } from "../../shared/attachment";
import { CHARS_PER_TOKEN, MAX_FILE_CHARS, TOOL_RESULT_BUDGET_RATIO } from "../../shared/constants";
import { StoredMessage } from "../../shared/history";
import {
  stripAttachment,
  userMessageForHistory,
  userMessageWithAttachment,
} from "../../shared/prompts";
import { buildTools, isDocumentSnapshotTool, STALE_DOCUMENT_READ } from "../../shared/tools";
import { ChatMessage } from "../../sidecar/types";
import {
  ABORTED_TOOL_RESULT,
  capToolResults,
  dropOldest,
  estimateTokens,
  fitContext,
  indexedReadCharLimit,
  messagesTokens,
  requestTokens,
  toChatMessages,
  toolSchemaTokens,
} from "./context";

function stored(partial: Partial<StoredMessage> & Pick<StoredMessage, "role">): StoredMessage {
  return {
    id: 1,
    content: "",
    reasoningContent: "",
    toolCalls: [],
    toolCallId: "",
    usage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("estimateTokens", () => {
  it("counts Japanese at the rate the server has been billing", () => {
    // 1.6 characters per token, fitted against recorded promptTokens.
    expect(estimateTokens("あいうえお")).toBe(4);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("toChatMessages", () => {
  it("replays past turns without their reasoning channel", () => {
    const chat = toChatMessages([
      stored({ role: "user", content: "点検して" }),
      stored({
        role: "assistant",
        content: "",
        reasoningContent: "長い思考",
        toolCalls: [
          { id: "c1", type: "function", function: { name: "insert_comment", arguments: "{}" } },
        ],
      }),
      stored({ role: "tool", content: "コメントを付けました。", toolCallId: "c1" }),
    ]);

    expect(chat[1].reasoning_content).toBeUndefined();
    expect(chat[1].tool_calls).toHaveLength(1);
    expect(chat[2].tool_call_id).toBe("c1");
  });

  it("drops the attached body, which the next turn reads from the document again", () => {
    const chat = toChatMessages([
      stored({
        role: "user",
        content: "点検して\n\n--- 文書全体 ---\n第1条（目的）\n第2条（報酬）",
      }),
    ]);
    expect(chat[0].content).toBe("点検して");
  });

  it("drops the selection that older conversations stored inline", () => {
    const chat = toChatMessages([
      stored({ role: "user", content: "整えて\n\n--- 選択範囲 ---\n甲は乙に委託する。" }),
    ]);
    expect(chat[0].content).toBe("整えて");
  });

  it("drops a document read on the next turn and keeps a delete report", () => {
    const chat = toChatMessages([
      stored({
        role: "assistant",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "read_paragraphs", arguments: '{"from":1,"view":"full"}' },
          },
          {
            id: "c2",
            type: "function",
            function: { name: "find_in_document", arguments: '{"q":"第6条"}' },
          },
          {
            id: "c3",
            type: "function",
            function: { name: "delete_paragraphs", arguments: '{"paragraphs":[4]}' },
          },
          {
            id: "c4",
            type: "function",
            function: { name: "read_indexed_file", arguments: '{"path":"C:\\\\契約.docx"}' },
          },
        ],
      }),
      stored({ role: "tool", content: "[1] 第1条 甲は乙に委託する。", toolCallId: "c1" }),
      stored({ role: "tool", content: "[8] 第6条を準用する", toolCallId: "c2" }),
      stored({ role: "tool", content: "段落 4 を削除しました。", toolCallId: "c3" }),
      stored({ role: "tool", content: "みなし合格とする。", toolCallId: "c4" }),
    ]);
    expect(chat[1].content).toBe(STALE_DOCUMENT_READ);
    expect(chat[2].content).toBe(STALE_DOCUMENT_READ);
    expect(chat[1].content).not.toContain("第1条");
    expect(chat[3].content).toBe("段落 4 を削除しました。");
    expect(chat[4].content).toBe("みなし合格とする。");
  });

  it("closes a tool call that was stored without a result", () => {
    const chat = toChatMessages([
      stored({
        role: "assistant",
        toolCalls: [
          { id: "c1", type: "function", function: { name: "format_text", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "set_outline_level", arguments: "{}" } },
        ],
      }),
      stored({ role: "tool", content: "太字にしました。", toolCallId: "c1" }),
      stored({ role: "user", content: "つぎ" }),
    ]);
    expect(chat.map((message) => message.role)).toEqual(["assistant", "tool", "tool", "user"]);
    expect(chat[1]).toMatchObject({
      role: "tool",
      content: "太字にしました。",
      tool_call_id: "c1",
    });
    expect(chat[2]).toEqual({
      role: "tool",
      content: ABORTED_TOOL_RESULT,
      tool_call_id: "c2",
    });
    expect(chat[3].content).toBe("つぎ");
  });

  it("closes every call when a cancelled turn saved none of the results", () => {
    const chat = toChatMessages([
      stored({
        role: "assistant",
        toolCalls: [
          { id: "c1", type: "function", function: { name: "format_text", arguments: "{}" } },
        ],
      }),
    ]);
    expect(chat[1]).toEqual({ role: "tool", content: ABORTED_TOOL_RESULT, tool_call_id: "c1" });
  });

  it("keeps the body of a tool report that follows its call", () => {
    const chat = toChatMessages([
      stored({
        role: "assistant",
        toolCalls: [
          { id: "c1", type: "function", function: { name: "insert_blocks", arguments: "{}" } },
        ],
      }),
      stored({
        role: "tool",
        content: "第1条の後ろに入れました\n\n--- 文書全体 ---\n表示用",
        toolCallId: "c1",
      }),
    ]);
    expect(chat[1].content).toContain("--- 文書全体 ---");
  });

  it("drops a tool message that has no call in the assistant just before it", () => {
    const chat = toChatMessages([
      stored({ role: "user", content: "点検して" }),
      stored({ role: "tool", content: "呼び出しのない結果", toolCallId: "call_0" }),
      stored({
        role: "assistant",
        toolCalls: [
          { id: "call_0", type: "function", function: { name: "format_text", arguments: "{}" } },
        ],
      }),
      stored({ role: "tool", content: "直しました。", toolCallId: "call_0" }),
      stored({ role: "tool", content: "余った結果", toolCallId: "call_9" }),
    ]);
    expect(chat.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(chat[2].content).toBe("直しました。");
  });
});

function calls(ids: string[], name = "format_text"): StoredMessage {
  return stored({
    role: "assistant",
    toolCalls: ids.map((id) => ({
      id,
      type: "function" as const,
      function: { name, arguments: "{}" },
    })),
  });
}

function toolResult(id: string, content: string): StoredMessage {
  return stored({ role: "tool", content, toolCallId: id });
}

/** Replay as of d0315ae, before missing tool results were repaired. */
function replayAtD0315ae(storedMessages: StoredMessage[]): ChatMessage[] {
  const names = new Map<string, string>();
  for (const message of storedMessages) {
    for (const call of message.toolCalls) {
      names.set(call.id, call.function.name);
    }
  }
  return storedMessages.map((message) => {
    let content = message.role === "user" ? stripAttachment(message.content) : message.content;
    if (message.role === "tool" && isDocumentSnapshotTool(names.get(message.toolCallId) || "")) {
      content = STALE_DOCUMENT_READ;
    }
    const chat: ChatMessage = { role: message.role, content };
    if (message.toolCalls.length) {
      chat.tool_calls = message.toolCalls;
    }
    if (message.toolCallId) {
      chat.tool_call_id = message.toolCallId;
    }
    return chat;
  });
}

function assertPaired(messages: ChatMessage[]): void {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "tool") {
      let previous = index - 1;
      while (previous >= 0 && messages[previous].role === "tool") {
        previous -= 1;
      }
      const assistant = messages[previous];
      expect(assistant?.role).toBe("assistant");
      const ids = (assistant?.tool_calls || []).map((call) => call.id);
      expect(ids).toContain(message.tool_call_id);
    }
    if (message.role !== "assistant" || !message.tool_calls?.length) {
      continue;
    }
    const want = message.tool_calls.map((call) => call.id).sort();
    const got: string[] = [];
    let follow = index + 1;
    while (follow < messages.length && messages[follow].role === "tool") {
      got.push(messages[follow].tool_call_id || "");
      follow += 1;
    }
    expect([...got].sort()).toEqual(want);
  }
}

describe("tool call ids repeat across turns", () => {
  it("repairs deleted results by the assistant they follow, then still pairs after trimming", () => {
    const transcript: StoredMessage[] = [
      stored({ role: "user", content: "あ".repeat(400) }),
      calls(["call_0", "call_1"], "read_paragraphs"),
      toolResult("call_1", "第2条だけ残った"),
      stored({ role: "tool", content: "どの呼び出しでもない", toolCallId: "call_9" }),
      stored({ role: "user", content: "つぎ" }),
      calls(["call_0", "call_1"]),
      stored({ role: "user", content: "いまの指示" }),
      calls(["call_0", "call_1"]),
      toolResult("call_0", "直しました。"),
      toolResult("call_0", "同じ id の余分な結果"),
      toolResult("call_7", "後ろに紛れた結果"),
    ];
    const chat = toChatMessages(transcript);
    assertPaired(chat);
    expect(
      chat.map((message) => [message.role, message.tool_call_id || "", message.content])
    ).toEqual([
      ["user", "", "あ".repeat(400)],
      ["assistant", "", ""],
      ["tool", "call_1", "第2条だけ残った"],
      ["tool", "call_0", ABORTED_TOOL_RESULT],
      ["user", "", "つぎ"],
      ["assistant", "", ""],
      ["tool", "call_0", ABORTED_TOOL_RESULT],
      ["tool", "call_1", ABORTED_TOOL_RESULT],
      ["user", "", "いまの指示"],
      ["assistant", "", ""],
      ["tool", "call_0", "直しました。"],
      ["tool", "call_1", ABORTED_TOOL_RESULT],
    ]);

    const fitted = dropOldest([{ role: "system", content: "ルール" }, ...chat], 80);
    assertPaired(fitted);
    expect(fitted[0].role).toBe("system");
    expect(fitted.some((message) => message.content === "あ".repeat(400))).toBe(false);
    expect(fitted.at(-1)?.tool_call_id).toBe("call_1");
  });

  it("replays a complete conversation the way d0315ae did", () => {
    const storedUser = userMessageForHistory("点検して", {
      ...EMPTY_ATTACHMENT,
      scope: "document",
      document: "第1条（目的）\n第2条（報酬）",
      paragraphs: 2,
      focus: "第2条（報酬）",
    });
    const outbound = userMessageWithAttachment("点検して", {
      ...EMPTY_ATTACHMENT,
      scope: "document",
      document: "第1条（目的）\n第2条（報酬）",
      paragraphs: 2,
      focus: "第2条（報酬）",
    });
    // The live request puts the instruction last and is never stored.
    expect(outbound.endsWith("点検して")).toBe(true);
    expect(storedUser.startsWith("点検して")).toBe(true);
    expect(outbound).not.toBe(storedUser);

    const transcript: StoredMessage[] = [
      stored({ role: "user", content: storedUser }),
      calls(["call_0"], "read_paragraphs"),
      toolResult("call_0", "[1] 第1条 甲は乙に委託する。"),
      calls(["call_1"], "format_text"),
      toolResult("call_1", "太字にしました。"),
      stored({ role: "user", content: "続けて" }),
      calls(["call_1"], "format_text"),
      toolResult("call_1", "次のターンでも call_1 です。"),
      stored({ role: "assistant", content: "直しました。" }),
    ];
    const replayed = toChatMessages(transcript);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(replayAtD0315ae(transcript)));
    expect(replayed[2].content).toBe(STALE_DOCUMENT_READ);
  });
});

describe("indexedReadCharLimit", () => {
  it("stays inside the tool-result share, and never past the file cap", () => {
    const limit = 131_072;
    const chars = indexedReadCharLimit(limit, []);
    expect(chars).toBeLessThanOrEqual(MAX_FILE_CHARS);
    const tokens = Math.ceil(chars / CHARS_PER_TOKEN) + 4;
    expect(tokens).toBeLessThanOrEqual(Math.floor(limit * TOOL_RESULT_BUDGET_RATIO));
  });

  it("shrinks by what earlier tool results already use", () => {
    const open = indexedReadCharLimit(131_072, []);
    const used = indexedReadCharLimit(131_072, ["あ".repeat(8000)]);
    expect(used).toBeLessThan(open);
  });
});

describe("dropOldest", () => {
  const conversation: ChatMessage[] = [
    { role: "system", content: "ルール" },
    { role: "user", content: "あ".repeat(400) },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "search", arguments: "{}" } }],
    },
    { role: "tool", content: "ヒット".repeat(100), tool_call_id: "c1" },
    { role: "user", content: "つぎ" },
  ];

  it("keeps everything when it already fits", () => {
    expect(dropOldest(conversation, 10_000)).toEqual(conversation);
  });

  it("keeps the system prompt and the newest message", () => {
    const trimmed = dropOldest(conversation, 10);
    expect(trimmed[0].role).toBe("system");
    expect(trimmed[trimmed.length - 1].content).toBe("つぎ");
  });

  it("pins the current instruction and the tool round after it", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "ルール" },
      { role: "user", content: "古い指示" },
      { role: "assistant", content: "古い返事" },
      { role: "user", content: "いまの指示" + "あ".repeat(400) },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c9", type: "function", function: { name: "search", arguments: "{}" } }],
      },
      { role: "tool", content: "結果", tool_call_id: "c9" },
    ];
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const trimmed = dropOldest(messages, 10);
      expect(trimmed.map((message) => message.role)).toEqual([
        "system",
        "user",
        "assistant",
        "tool",
      ]);
      expect(trimmed[1].content?.startsWith("いまの指示")).toBe(true);
      expect(trimmed.some((message) => message.content === "古い指示")).toBe(false);
      expect(info.mock.calls.some((call) => call[1] === "context trim")).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  it("never leaves a tool reply without its call", () => {
    const trimmed = dropOldest(conversation, 240);
    const orphan = trimmed.some(
      (message, index) => message.role === "tool" && !trimmed[index - 1]?.tool_calls?.length
    );
    expect(orphan).toBe(false);
    expect(messagesTokens(trimmed)).toBeLessThanOrEqual(240);
  });
});

describe("tool schema in the meter", () => {
  it("counts the schema on top of the messages", () => {
    const tools = buildTools({ search: true, argos: true, selection: true, numbered: true });
    const messages: ChatMessage[] = [{ role: "system", content: "ルール" }];
    const schema = toolSchemaTokens(tools);
    expect(schema).toBeGreaterThan(1000);
    expect(requestTokens(messages, tools)).toBe(messagesTokens(messages) + schema);
    expect(requestTokens(messages)).toBe(messagesTokens(messages));
  });

  it("fits messages into the room left after the schema", () => {
    const tools = buildTools({ search: false, selection: false, numbered: false });
    const schema = toolSchemaTokens(tools);
    const current = "いまの指示";
    const messages: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "あ".repeat(CHARS_PER_TOKEN * 80) },
      { role: "assistant", content: "古い返事" },
      { role: "user", content: current },
    ];
    const tail = messagesTokens([messages[0], messages[3]]);
    const limit = tail + schema + 5;
    const fitted = fitContext(messages, limit, tools);
    expect(fitted.map((message) => message.content)).toEqual(["s", current]);
    expect(requestTokens(fitted, tools)).toBeLessThanOrEqual(limit);
    expect(fitContext(messages, limit).length).toBe(messages.length);
  });
});

describe("capToolResults", () => {
  it("leaves small results alone", () => {
    const messages: ChatMessage[] = [{ role: "tool", content: "短い結果", tool_call_id: "c1" }];
    expect(capToolResults(messages, 10_000)).toEqual(messages);
  });

  it("shrinks the oldest results so the newest survive intact", () => {
    const messages: ChatMessage[] = [
      { role: "tool", content: "古".repeat(2000), tool_call_id: "c1" },
      { role: "user", content: "質問" },
      { role: "tool", content: "新".repeat(200), tool_call_id: "c2" },
    ];
    const capped = capToolResults(messages, 1_000);

    expect(capped[0].content).toContain("省略");
    expect(capped[1]).toEqual(messages[1]);
    expect(capped[2].content).toBe(messages[2].content);
  });
});
