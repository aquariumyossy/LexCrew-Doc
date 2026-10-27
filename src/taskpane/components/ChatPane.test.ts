import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FluentProvider } from "@fluentui/react-components";
import { describe, expect, it } from "vitest";
import { StoredMessage } from "../../shared/history";
import { guriLightTheme } from "../theme";
import ChatPane from "./ChatPane";

function message(partial: Partial<StoredMessage>): StoredMessage {
  return {
    id: 1,
    role: "assistant",
    content: "",
    reasoningContent: "",
    toolCalls: [],
    toolCallId: "",
    usage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function html(messages: StoredMessage[], draft?: { content: string; reasoningContent: string }) {
  return renderToStaticMarkup(
    React.createElement(
      FluentProvider,
      { theme: guriLightTheme },
      React.createElement(ChatPane, { messages, draft })
    )
  );
}

describe("ChatPane tool names", () => {
  it("reads the name from the call just before the result when call_0 is reused", () => {
    const hits = JSON.stringify([
      { title: "民法", url: "http://example.test/minpo", content: "条文" },
    ]);
    const markup = html([
      message({
        id: 1,
        role: "assistant",
        toolCalls: [
          {
            id: "call_0",
            type: "function",
            function: { name: "search", arguments: '{"q":"民法"}' },
          },
        ],
      }),
      message({ id: 2, role: "tool", toolCallId: "call_0", content: hits }),
      message({
        id: 3,
        role: "assistant",
        toolCalls: [
          { id: "call_0", type: "function", function: { name: "format_text", arguments: "{}" } },
        ],
      }),
      message({ id: 4, role: "tool", toolCallId: "call_0", content: "太字にしました。" }),
    ]);
    expect(markup).toContain("検索結果 1 件");
    expect(markup).toContain("民法");
  });
});

describe("ChatPane foreign character notice", () => {
  it("warns when the assistant reply mixes simplified Chinese", () => {
    const markup = html([message({ content: "这个条款を直しました。" })]);
    expect(markup).toContain("日本語で用いない文字");
    expect(markup).toContain("这");
    expect(markup).toContain("个");
  });

  it("warns when the assistant reply slips into Korean", () => {
    const markup = html([message({ content: "権利侵害の主張 기타 クレームを直しました。" })]);
    expect(markup).toContain("日本語で用いない文字");
    expect(markup).toContain("기");
  });

  it("does not warn on Japanese-only replies", () => {
    const markup = html([message({ content: "第1条を点検しました。" })]);
    expect(markup).not.toContain("日本語で用いない文字");
  });

  it("warns while the reply is still streaming", () => {
    const markup = html([], { content: "这里。", reasoningContent: "" });
    expect(markup).toContain("日本語で用いない文字");
  });

  it("warns when tool arguments mix simplified Chinese even if the reply is empty", () => {
    const markup = html([
      message({
        content: "",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: {
              name: "insert_blocks",
              arguments: JSON.stringify({ blocks: [{ type: "body", text: "这个条款。" }] }),
            },
          },
        ],
      }),
    ]);
    expect(markup).toContain("日本語で用いない文字");
    expect(markup).toContain("这");
  });
});
