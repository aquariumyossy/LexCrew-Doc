import { describe, expect, it } from "vitest";
import { parseCompletion, stripThinking } from "./stripThinking";

describe("stripThinking", () => {
  it("drops think blocks and keeps the final answer", () => {
    expect(stripThinking("<think>内部</think>\n本文です")).toBe("本文です");
  });

  it("drops an unclosed think prefix", () => {
    expect(stripThinking("<think>途中\n最終")).toBe("");
  });
});

describe("parseCompletion", () => {
  it("keeps the reasoning channel separate from the answer", () => {
    const completion = parseCompletion({
      choices: [
        {
          finish_reason: "stop",
          message: { content: "<think>隠す</think>本文", reasoning_content: "まだ考え中" },
        },
      ],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 40,
        total_tokens: 160,
        completion_tokens_details: { reasoning_tokens: 25 },
      },
    });

    expect(completion.content).toBe("本文");
    expect(completion.reasoningContent).toBe("まだ考え中");
    expect(completion.finishReason).toBe("stop");
    expect(completion.usage).toEqual({
      promptTokens: 120,
      completionTokens: 40,
      totalTokens: 160,
      reasoningTokens: 25,
    });
  });

  it("reads tool calls", () => {
    const completion = parseCompletion({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "",
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "search", arguments: '{"q":"民法"}' },
              },
            ],
          },
        },
      ],
    });

    expect(completion.finishReason).toBe("tool_calls");
    expect(completion.toolCalls).toHaveLength(1);
    expect(completion.toolCalls[0].function.name).toBe("search");
    expect(completion.usage).toBeNull();
  });

  it("returns empty fields for an unusable payload", () => {
    const completion = parseCompletion({});
    expect(completion.content).toBe("");
    expect(completion.toolCalls).toEqual([]);
  });
});
