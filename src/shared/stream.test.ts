import { describe, expect, it } from "vitest";
import { StreamAccumulator, takeSseData } from "./stream";

describe("StreamAccumulator", () => {
  it("concatenates content and reasoning deltas", () => {
    const acc = new StreamAccumulator();
    acc.ingest({ choices: [{ delta: { reasoning_content: "考" } }] });
    acc.ingest({ choices: [{ delta: { reasoning_content: "える" } }] });
    acc.ingest({ choices: [{ delta: { content: "本文" } }] });
    acc.ingest({ choices: [{ delta: { content: "です。" }, finish_reason: "stop" }] });
    acc.ingest({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    });

    const done = acc.finish();
    expect(done.reasoningContent).toBe("考える");
    expect(done.content).toBe("本文です。");
    expect(done.finishReason).toBe("stop");
    expect(done.usage?.totalTokens).toBe(14);
    expect(done.usage?.reasoningTokens).toBe(2);
  });

  it("merges streamed tool_calls by index", () => {
    const acc = new StreamAccumulator();
    acc.ingest({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "c1", function: { name: "search", arguments: '{"q":' } }],
          },
        },
      ],
    });
    acc.ingest({
      choices: [
        {
          finish_reason: "tool_calls",
          delta: { tool_calls: [{ index: 0, function: { arguments: '"民法"}' } }] },
        },
      ],
    });

    const done = acc.finish();
    expect(done.finishReason).toBe("tool_calls");
    expect(done.toolCalls).toEqual([
      { id: "c1", type: "function", function: { name: "search", arguments: '{"q":"民法"}' } },
    ]);
  });

  it("treats a full JSON message as a one-shot chunk", () => {
    const acc = new StreamAccumulator();
    acc.ingest({
      choices: [{ finish_reason: "stop", message: { content: "コメントを付けました。" } }],
    });
    expect(acc.finish().content).toBe("コメントを付けました。");
  });

  it("throws when the stream carries an error object", () => {
    const acc = new StreamAccumulator();
    expect(() => acc.ingest({ error: { message: "context length" } })).toThrow(/context length/);
  });
});

describe("takeSseData", () => {
  it("yields complete data lines and keeps a partial tail", () => {
    const { events, rest } = takeSseData('data: {"a":1}\n\ndata: {"b":');
    expect(events).toEqual(['{"a":1}']);
    expect(rest).toBe('data: {"b":');
  });

  it("skips [DONE]", () => {
    const { events } = takeSseData("data: [DONE]\n");
    expect(events).toEqual(["[DONE]"]);
  });
});
