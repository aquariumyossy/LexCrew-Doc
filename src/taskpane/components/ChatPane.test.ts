import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, FluentProvider } from "@fluentui/react-components";
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

function html(
  messages: StoredMessage[],
  draft?: { content: string; reasoningContent: string },
  editConfirm?: { onAllow: () => void; onDecline: () => void } | null
) {
  return renderToStaticMarkup(
    React.createElement(
      FluentProvider,
      { theme: guriLightTheme },
      React.createElement(ChatPane, { messages, draft, editConfirm })
    )
  );
}

function buttonClass(appearance: "primary" | "secondary"): string {
  const markup = renderToStaticMarkup(
    React.createElement(
      FluentProvider,
      { theme: guriLightTheme },
      React.createElement(Button, { appearance }, "見本")
    )
  );
  const found = markup.match(/<button[^>]*class="([^"]*)"/);
  if (!found) {
    throw new Error(markup);
  }
  return found[1];
}

describe("ChatPane edit confirmation", () => {
  it("shows the question-turn prompt and emphasizes 変更してよい", () => {
    const markup = html([message({ role: "user", content: "なぜ？" })], undefined, {
      onAllow: () => undefined,
      onDecline: () => undefined,
    });
    expect(markup).toContain("質問への回答として文書を変えようとしています");
    expect(markup).toContain("変更してよい");
    expect(markup).toContain("変更せずに答えて");
    const buttons = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || [];
    const classOf = (label: string) =>
      buttons.find((button) => button.includes(label))?.match(/class="([^"]*)"/)?.[1];
    expect(classOf("変更してよい")).toBe(buttonClass("primary"));
    expect(classOf("変更せずに答えて")).toBe(buttonClass("secondary"));
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
