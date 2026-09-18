import { describe, expect, it } from "vitest";
import {
  ChangeNote,
  CommentNote,
  attachmentCharBudget,
  changeChars,
  commentChars,
  describeAttachment,
  markupCharBudget,
} from "./attachment";
import { DEFAULT_CONTEXT_LIMIT, MAX_ATTACHMENT_CHARS } from "./constants";

describe("attachmentCharBudget", () => {
  it("leaves half the window for the conversation and the reply", () => {
    // 32,768 tokens at 1.6 characters each, halved.
    expect(attachmentCharBudget(32_768)).toBe(26_214);
  });

  it("stops at the ceiling however wide the window is", () => {
    expect(attachmentCharBudget(DEFAULT_CONTEXT_LIMIT)).toBe(MAX_ATTACHMENT_CHARS);
    expect(attachmentCharBudget(1_000_000)).toBe(MAX_ATTACHMENT_CHARS);
  });

  it("attaches nothing when the window is unusable", () => {
    expect(attachmentCharBudget(0)).toBe(0);
    expect(attachmentCharBudget(Number.NaN)).toBe(0);
  });
});

describe("markupCharBudget", () => {
  it("reserves a slice for the markup, so the body cannot crowd it out", () => {
    expect(markupCharBudget(100_000)).toBe(30_000);
  });

  it("reserves nothing out of nothing", () => {
    expect(markupCharBudget(0)).toBe(0);
    expect(markupCharBudget(-10)).toBe(0);
  });
});

describe("markup sizes", () => {
  it("counts a comment with its anchor and its replies", () => {
    const note: CommentNote = {
      author: "田中",
      date: "2026-09-10",
      resolved: false,
      anchor: "代金",
      content: "下げたい",
      replies: [{ author: "佐藤", date: "2026-09-11", content: "検討する" }],
    };
    expect(commentChars(note)).toBe(commentChars({ ...note, replies: [] }) + 2 + 10 + 4);
  });

  it("counts a change with the paragraph that places it", () => {
    const note: ChangeNote = {
      kind: "delete",
      author: "田中",
      date: "2026-09-10",
      text: "無催告で",
      where: "第12条",
    };
    expect(changeChars(note)).toBe(2 + 10 + 4 + 4);
  });
});

describe("describeAttachment", () => {
  const base = { scope: "document" as const, documentChars: 24_300, focusChars: 0 };

  it("names both parts so the cost of the turn is visible", () => {
    const text = describeAttachment({ ...base, focusChars: 940, paragraphs: 78 });
    expect(text).toContain("文書全体 24,300 字（78 段落）");
    expect(text).toContain("選択 940 字");
  });

  it("leaves out the paragraph count before anything has counted them", () => {
    expect(describeAttachment(base)).toBe("文書全体 24,300 字を添付します");
  });

  it("says when the body was cut", () => {
    expect(describeAttachment({ ...base, truncated: true })).toContain("途中まで");
  });

  it("counts the comments and the changes that will ride along", () => {
    const text = describeAttachment({ ...base, markup: true, comments: 12, changes: 30 });
    expect(text).toContain("コメント 12 件");
    expect(text).toContain("変更履歴 30 件");
  });

  it("leaves the counts out when the user turned the markup off", () => {
    const text = describeAttachment({ ...base, markup: false, comments: 12, changes: 30 });
    expect(text).not.toContain("コメント");
  });

  it("is plain about attaching nothing", () => {
    expect(describeAttachment({ ...base, scope: "none" })).toBe("添付しません");
    expect(describeAttachment({ ...base, scope: "selection", documentChars: 0 })).toBe(
      "選択がないので添付しません"
    );
    expect(describeAttachment({ ...base, documentChars: 0 })).toBe("文書が空です");
  });
});
