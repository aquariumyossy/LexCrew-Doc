import { describe, expect, it } from "vitest";
import { StoredMessage } from "../../shared/history";
import { ChatMessage } from "../../sidecar/types";
import {
  capToolResults,
  dropOldest,
  estimateTokens,
  messagesTokens,
  toChatMessages,
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

  it("leaves assistant and tool messages as they are", () => {
    const chat = toChatMessages([
      stored({ role: "tool", content: "第1条の後ろに入れました\n\n--- 文書全体 ---\n表示用" }),
    ]);
    expect(chat[0].content).toContain("--- 文書全体 ---");
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

  it("never leaves a tool reply without its call", () => {
    const trimmed = dropOldest(conversation, 240);
    const orphan = trimmed.some(
      (message, index) => message.role === "tool" && !trimmed[index - 1]?.tool_calls?.length
    );
    expect(orphan).toBe(false);
    expect(messagesTokens(trimmed)).toBeLessThanOrEqual(240);
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
