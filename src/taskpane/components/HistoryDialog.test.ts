import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FluentProvider } from "@fluentui/react-components";
import { describe, expect, it } from "vitest";
import { ConversationSummary } from "../../shared/history";
import { guriLightTheme } from "../theme";
import { HistoryConversationList } from "./HistoryDialog";

function summary(partial: Partial<ConversationSummary>): ConversationSummary {
  return {
    id: "c1",
    title: "会話",
    documentKey: "",
    documentPath: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T03:04:00.000Z",
    messageCount: 2,
    argosPathPrefix: "",
    ...partial,
  };
}

function markup(conversations: ConversationSummary[], documentKey = "", documentPath = "") {
  return renderToStaticMarkup(
    React.createElement(
      FluentProvider,
      { theme: guriLightTheme },
      React.createElement(HistoryConversationList, {
        conversations,
        activeId: null,
        currentDocumentKey: documentKey,
        currentDocumentPath: documentPath,
        onSelect: () => undefined,
        onDelete: () => undefined,
      })
    )
  );
}

describe("HistoryDialog", () => {
  it("pins the open document above other files", () => {
    const html = markup(
      [
        summary({ id: "b1", title: "別件", documentKey: "docB", documentPath: "C:\\b.docx" }),
        summary({ id: "a1", title: "条項の点検", documentKey: "docA", documentPath: "" }),
      ],
      "docA",
      "file:///C:/a/contract.docx"
    );
    expect(html).toContain("この文書");
    expect(html).toContain("contract.docx");
    expect(html).toContain('title="file:///C:/a/contract.docx"');
    expect(html).toContain("ほかの文書");
    expect(html).toContain("b.docx");
    expect(html).toContain("別件");
    expect(html.indexOf("条項の点検")).toBeLessThan(html.indexOf("ほかの文書"));
    expect(html.indexOf("ほかの文書")).toBeLessThan(html.indexOf("別件"));
    expect(html).not.toContain("まだ会話がありません。");
    expect(html).not.toContain("この文書の履歴はまだありません。");
  });

  it("keeps the open document heading when that file has no conversations", () => {
    const html = markup(
      [summary({ id: "b1", title: "別件", documentKey: "docB", documentPath: "C:\\b.docx" })],
      "docA",
      "file:///C:/a/contract.docx"
    );
    expect(html).toContain("この文書");
    expect(html).toContain("contract.docx");
    expect(html).toContain("この文書の履歴はまだありません。");
    expect(html).toContain("ほかの文書");
    expect(html).toContain("別件");
    expect(html).not.toContain("まだ会話がありません。");
  });

  it("omits the other-files heading when every conversation is for the open document", () => {
    const html = markup(
      [summary({ id: "a1", title: "条項の点検", documentKey: "docA" })],
      "docA",
      "file:///C:/a/contract.docx"
    );
    expect(html).toContain("条項の点検");
    expect(html).not.toContain("ほかの文書");
    expect(html).not.toContain("この文書の履歴はまだありません。");
  });

  it("names an unsaved open document and skips the global empty line", () => {
    const html = markup([], "docA", "");
    expect(html).toContain("この文書");
    expect(html).toContain("未保存の文書");
    expect(html).toContain("この文書の履歴はまだありません。");
    expect(html).not.toContain("ほかの文書");
    expect(html).not.toContain("まだ会話がありません。");
  });

  it("lists files without section headings when no document is open", () => {
    const html = markup([
      summary({ id: "a1", title: "条項の点検", documentKey: "docA", documentPath: "C:\\a.docx" }),
    ]);
    expect(html).toContain("条項の点検");
    expect(html).toContain("a.docx");
    expect(html).not.toContain("この文書");
    expect(html).not.toContain("ほかの文書");
  });

  it("uses the global empty line when nothing is stored and no document is open", () => {
    const html = markup([]);
    expect(html).toContain("まだ会話がありません。");
    expect(html).not.toContain("この文書");
    expect(html).not.toContain("ほかの文書");
  });
});
