import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatBody, chatStream } from "./api";

const body: ChatBody = {
  llmBaseUrl: "http://x/v1",
  llmApiKey: "k",
  model: "qwen3.8-flash-next",
  messages: [{ role: "user", content: "点検して" }],
  thinkingLevel: "medium",
  thinkingBudget: 2048,
  timeoutMs: 180000,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chatStream", () => {
  it("assembles SSE deltas into the final reply", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"こん"}}]}\n\n'));
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"にちは"},"finish_reason":"stop"}]}\n\n'
          )
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshots: string[] = [];
    const done = await chatStream(body, {
      onDelta: (snapshot) => snapshots.push(snapshot.content),
    });

    expect(done.content).toBe("こんにちは");
    expect(done.finishReason).toBe("stop");
    expect(snapshots.at(-1)).toBe("こんにちは");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    const sent = JSON.parse(String(init?.body)) as { stream?: boolean };
    expect(sent.stream).toBe(true);
  });
});
