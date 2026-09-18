import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FluentProvider } from "@fluentui/react-components";
import { describe, expect, it } from "vitest";
import { guriLightTheme } from "../theme";
import MarkdownView, { CollapsedLink } from "./MarkdownView";

function html(text: string): string {
  return renderToStaticMarkup(
    React.createElement(
      FluentProvider,
      { theme: guriLightTheme },
      React.createElement(MarkdownView, { text })
    )
  );
}

describe("MarkdownView", () => {
  it("renders headings, bold, and lists", () => {
    const markup = html("## 点検\n\nこの条項は**未確認**です。\n\n- 一点\n- 二点");
    expect(markup).toContain("<h2>");
    expect(markup).toContain("点検");
    expect(markup).toContain("<strong>");
    expect(markup).toContain("未確認");
    expect(markup).toContain("<li>");
    expect(markup).toContain("一点");
  });

  it("renders GFM tables", () => {
    const markup = html("| 項目 | 内容 |\n| --- | --- |\n| 期限 | 未確認 |");
    expect(markup).toContain("<table>");
    expect(markup).toContain("<th>");
    expect(markup).toContain("<td>");
    expect(markup).toContain("期限");
    expect(markup).toContain("未確認");
  });

  it("does not render raw HTML tags", () => {
    const markup = html("注意 <script>alert(1)</script> **重要**");
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("<strong>");
    expect(markup).toContain("重要");
  });

  it("folds a Windows path without turning it into an http link", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        FluentProvider,
        { theme: guriLightTheme },
        React.createElement(CollapsedLink, { href: "C:\\案件A\\契約.md" })
      )
    );
    expect(markup).toContain("契約.md");
    expect(markup).toContain("C:\\案件A\\契約.md");
    expect(markup).not.toContain('href="C:\\案件A\\契約.md"');
  });
});
