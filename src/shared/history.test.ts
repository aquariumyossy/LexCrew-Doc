import { describe, expect, it } from "vitest";
import {
  ConversationSummary,
  UNKNOWN_DOCUMENT_LABEL,
  UNSAVED_DOCUMENT_LABEL,
  conversationDocumentLabel,
  conversationTitle,
  documentFileName,
  groupConversationsByDocument,
} from "./history";

describe("conversationTitle", () => {
  it("uses the first non-empty line and truncates", () => {
    expect(conversationTitle("この条項を点検して")).toBe("この条項を点検して");
    expect(conversationTitle("\n  \n見出し\n続き")).toBe("見出し");
    expect(conversationTitle("あ".repeat(41)).endsWith("…")).toBe(true);
  });
});

describe("documentFileName", () => {
  it("takes the file name from Word file URLs and Windows paths", () => {
    expect(documentFileName("file:///C:/案件/秘密保持契約書.docx")).toBe("秘密保持契約書.docx");
    expect(documentFileName("C:\\案件\\秘密保持契約書.docx")).toBe("秘密保持契約書.docx");
    expect(
      documentFileName(
        "https://contoso.sharepoint.com/sites/a/Shared%20Documents/%E5%A5%91%E7%B4%84.docx"
      )
    ).toBe("契約.docx");
    expect(documentFileName("")).toBe("");
  });
});

describe("conversationDocumentLabel", () => {
  it("prefers the open document's name and falls back honestly", () => {
    const row = { documentKey: "docA", documentPath: "" };
    expect(conversationDocumentLabel(row, "docA", "file:///C:/a/契約.docx")).toBe("契約.docx");
    expect(conversationDocumentLabel(row, "docA", "")).toBe(UNSAVED_DOCUMENT_LABEL);
    expect(conversationDocumentLabel(row, "docB", "file:///C:/a/契約.docx")).toBe(
      UNKNOWN_DOCUMENT_LABEL
    );
  });
});

function summary(partial: Partial<ConversationSummary>): ConversationSummary {
  return {
    id: "c1",
    title: "会話",
    documentKey: "",
    documentPath: "",
    createdAt: "",
    updatedAt: "",
    messageCount: 0,
    argosPathPrefix: "",
    ...partial,
  };
}

describe("groupConversationsByDocument", () => {
  it("keeps newest-first groups and folds later rows of the same document", () => {
    const grouped = groupConversationsByDocument([
      summary({ id: "a1", documentKey: "docA", documentPath: "C:\\a.docx" }),
      summary({ id: "b1", documentKey: "docB", documentPath: "C:\\b.docx" }),
      summary({ id: "a2", documentKey: "docA", documentPath: "" }),
    ]);
    expect(grouped.map((group) => group.conversations.map((row) => row.id))).toEqual([
      ["a1", "a2"],
      ["b1"],
    ]);
    expect(grouped[0].documentPath).toBe("C:\\a.docx");
  });
});
