import { afterEach, describe, expect, it } from "vitest";
import { insertComment, readAttachment, readDocumentText, replaceQuote } from "./word";

/* global globalThis */

type Replacement = { target: string; text: string };

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

type FakeComment = {
  author: string;
  date: Date;
  resolved?: boolean;
  anchor: string;
  content: string;
  replies?: { author: string; date: Date; content: string }[];
};

type FakeChange = { type: string; author: string; date: Date; text: string; where: string };

type WordOptions = {
  selection: string;
  body: string;
  paragraphs?: string[];
  markupComments?: FakeComment[];
  markupChanges?: FakeChange[];
  /** Word refusing the call at all, as a tracked move does to getTrackedChanges. */
  commentsFail?: string;
  changesFail?: string;
  /** Sync number after which every sync throws, to lose the extras but not the list. */
  failSyncAfter?: number;
  /** False stands for a Word too old for tracked changes. */
  wordApi16?: boolean;
};

/**
 * Enough of Word.run for the quote-resolving paths: a selection and a body that
 * each report how many times the needle occurs, and ranges that record what was
 * written to them. Comments and tracked changes are served from plain objects.
 */
function installWord(options: WordOptions): {
  replacements: Replacement[];
  comments: string[];
} {
  const replacements: Replacement[] = [];
  const comments: string[] = [];

  const stripSpace = (value: string) => value.replace(/[\s\u3000]/g, "");
  const makeRange = (text: string) => ({
    text,
    load: () => undefined,
    insertText: (value: string) => replacements.push({ target: text, text: value }),
    insertComment: (value: string) => comments.push(value),
    // Word's own ignoreSpace is what runs in production; here it only has to
    // prove the second pass happens and the first one is preferred.
    search: (needle: string, options?: { ignoreSpace?: boolean }) => {
      const haystack = options?.ignoreSpace ? stripSpace(text) : text;
      const target = options?.ignoreSpace ? stripSpace(needle) : needle;
      return {
        load: () => undefined,
        items: Array.from({ length: countOccurrences(haystack, target) }, () => makeRange(needle)),
      };
    },
  });

  const getComments = () => {
    if (options.commentsFail) {
      throw new Error(options.commentsFail);
    }
    return {
      load: () => undefined,
      items: (options.markupComments || []).map((comment) => ({
        authorName: comment.author,
        creationDate: comment.date,
        content: comment.content,
        resolved: comment.resolved === true,
        getRange: () => makeRange(comment.anchor),
        replies: {
          load: () => undefined,
          items: (comment.replies || []).map((reply) => ({
            authorName: reply.author,
            creationDate: reply.date,
            content: reply.content,
          })),
        },
      })),
    };
  };

  const getTrackedChanges = () => {
    if (options.changesFail) {
      throw new Error(options.changesFail);
    }
    return {
      load: () => undefined,
      items: (options.markupChanges || []).map((change) => ({
        type: change.type,
        author: change.author,
        date: change.date,
        text: change.text,
        getRange: () => ({
          paragraphs: { getFirst: () => ({ text: change.where, load: () => undefined }) },
        }),
      })),
    };
  };

  const selection = { ...makeRange(options.selection), getComments, getTrackedChanges };
  const body = {
    ...makeRange(options.body),
    // Word ends every paragraph with a carriage return.
    paragraphs: {
      load: () => undefined,
      items: (options.paragraphs || []).map((text) => ({ text: `${text}\r` })),
    },
    getComments,
    getTrackedChanges,
  };
  let syncs = 0;
  const context = {
    document: {
      changeTrackingMode: "",
      getSelection: () => selection,
      body,
    },
    sync: async () => {
      syncs += 1;
      if (options.failSyncAfter !== undefined && syncs > options.failSyncAfter) {
        throw new Error("同期に失敗しました");
      }
    },
  };

  (globalThis as unknown as { Word: unknown }).Word = {
    run: (callback: (ctx: unknown) => Promise<unknown>) => callback(context),
    ChangeTrackingMode: { trackAll: "trackAll" },
    InsertLocation: { replace: "Replace", after: "After" },
    SelectionMode: { end: "End" },
  };
  (globalThis as unknown as { Office: unknown }).Office = {
    context: {
      host: "Word",
      requirements: {
        isSetSupported: (name: string, version: string) =>
          name !== "WordApi" || version !== "1.6" || options.wordApi16 !== false,
      },
    },
    HostType: { Word: "Word" },
  };

  return { replacements, comments };
}

afterEach(() => {
  delete (globalThis as unknown as { Word?: unknown }).Word;
  delete (globalThis as unknown as { Office?: unknown }).Office;
});

describe("quote targeting", () => {
  it("replaces the one match when the quote is unique in the body", async () => {
    const word = installWord({ selection: "", body: "第1条 定義する。第2条 報酬を支払う。" });
    await replaceQuote("報酬を支払う", "報酬を翌月末までに支払う");
    expect(word.replacements).toEqual([
      { target: "報酬を支払う", text: "報酬を翌月末までに支払う" },
    ]);
  });

  it("refuses a quote that matches the body twice instead of taking the first", async () => {
    const word = installWord({ selection: "", body: "甲は、乙に対し。第5条 甲は、乙に対し。" });
    await expect(replaceQuote("甲は、乙に対し", "甲は、丙に対し")).rejects.toThrow(/2 箇所/);
    expect(word.replacements).toEqual([]);
  });

  it("refuses a quote that matches the selection twice", async () => {
    installWord({ selection: "本契約は。本契約は。", body: "本契約は。本契約は。" });
    await expect(replaceQuote("本契約は", "本覚書は")).rejects.toThrow(/選択範囲に 2 箇所/);
  });

  it("names the paragraph and length limits so the retry can succeed", async () => {
    installWord({ selection: "", body: "甲。甲。" });
    await expect(replaceQuote("甲", "乙")).rejects.toThrow(/255 字まで/);
  });

  it("falls back to a space-insensitive search for a clause label", async () => {
    const word = installWord({ selection: "", body: "第12条　（協議）　甲乙は協議する。" });
    await replaceQuote("第12条（協議）", "第13条（協議）");
    expect(word.replacements).toEqual([{ target: "第12条（協議）", text: "第13条（協議）" }]);
  });

  it("prefers an exact match over the space-insensitive one", async () => {
    const word = installWord({ selection: "", body: "第12条（協議）と第12条　（協議）" });
    await replaceQuote("第12条（協議）", "第13条（協議）");
    expect(word.replacements).toHaveLength(1);
  });

  it("still reports a quote that is nowhere in the body", async () => {
    installWord({ selection: "", body: "第1条 定義する。" });
    await expect(replaceQuote("第9条", "第9条")).rejects.toThrow(/見つかりませんでした/);
  });

  it("applies the same check to comments", async () => {
    const word = installWord({ selection: "", body: "解除できる。解除できる。" });
    await expect(insertComment("要検討です。", "解除できる", "high")).rejects.toThrow(/2 箇所/);
    expect(word.comments).toEqual([]);
  });

  it("asks for a quote rather than editing an empty selection", async () => {
    const word = installWord({ selection: "", body: "第1条 定義する。" });
    await expect(insertComment("要検討です。", "", "medium")).rejects.toThrow(
      /選択範囲がありません/
    );
    expect(word.comments).toEqual([]);
  });
});

describe("readDocumentText", () => {
  const paragraphs = ["売買契約書", "第1条（目的）", "第2条（代金）"];

  it("returns one line per paragraph, without Word's carriage returns", async () => {
    installWord({ selection: "", body: "", paragraphs });
    const read = await readDocumentText(1_000);
    expect(read.text).toBe("売買契約書\n第1条（目的）\n第2条（代金）");
    expect(read.paragraphs).toBe(3);
    expect(read.truncated).toBe(false);
  });

  it("stops at a paragraph boundary when the budget runs out", async () => {
    installWord({ selection: "", body: "", paragraphs });
    const read = await readDocumentText(12);
    expect(read.text).toBe("売買契約書");
    expect(read.paragraphs).toBe(1);
    expect(read.truncated).toBe(true);
  });

  it("reads nothing when there is no budget left", async () => {
    installWord({ selection: "", body: "", paragraphs });
    const read = await readDocumentText(0);
    expect(read).toEqual({ text: "", paragraphs: 0, truncated: false });
  });
});

describe("readAttachment", () => {
  const paragraphs = ["第1条（目的）", "第2条（代金）"];

  it("sends the body and the selection together, so the model knows where to look", async () => {
    installWord({ selection: "第2条（代金）", body: "", paragraphs });
    const attachment = await readAttachment("document", 1_000, false);
    expect(attachment.document).toContain("第1条（目的）");
    expect(attachment.focus).toBe("第2条（代金）");
    expect(attachment.paragraphs).toBe(2);
  });

  it("leaves the body out when the user asked for the selection only", async () => {
    installWord({ selection: "第2条（代金）", body: "", paragraphs });
    const attachment = await readAttachment("selection", 1_000, false);
    expect(attachment.document).toBe("");
    expect(attachment.focus).toBe("第2条（代金）");
  });

  it("attaches nothing at all when asked for nothing", async () => {
    installWord({ selection: "第2条（代金）", body: "", paragraphs });
    const attachment = await readAttachment("none", 1_000, true);
    expect(attachment.document).toBe("");
    expect(attachment.focus).toBe("");
    expect(attachment.markup).toBe(false);
  });

  it("charges the selection against the same budget, since both are sent", async () => {
    installWord({ selection: "第2条（代金）", body: "", paragraphs });
    const attachment = await readAttachment("document", 8, false);
    expect(attachment.focus).toBe("第2条（代金）");
    expect(attachment.document).toBe("");
    expect(attachment.truncated).toBe(true);
  });
});

describe("reading comments and tracked changes", () => {
  const paragraphs = ["第1条（目的）", "第2条（代金）"];
  const comment: FakeComment = {
    author: "田中太郎",
    date: new Date(2026, 8, 10),
    anchor: "代金は、金100万円とする",
    content: "分割払いにしたい。",
    replies: [{ author: "佐藤花子", date: new Date(2026, 8, 11), content: "検討します。" }],
  };
  const change: FakeChange = {
    type: "Deleted",
    author: "田中太郎",
    date: new Date(2026, 8, 10),
    text: "無催告で",
    where: "第12条（解除）売主は、無催告で本契約を解除できる。",
  };

  it("reads a comment with who wrote it, what it points at and the replies", async () => {
    installWord({ selection: "", body: "", paragraphs, markupComments: [comment] });
    const attachment = await readAttachment("document", 10_000, true);
    expect(attachment.comments.items).toHaveLength(1);
    expect(attachment.comments.items[0]).toMatchObject({
      author: "田中太郎",
      date: "2026-09-10",
      resolved: false,
      anchor: "代金は、金100万円とする",
      content: "分割払いにしたい。",
    });
    expect(attachment.comments.items[0].replies[0].content).toBe("検討します。");
  });

  it("names the paragraph a deletion sits in, which the body may no longer show", async () => {
    installWord({ selection: "", body: "", paragraphs, markupChanges: [change] });
    const attachment = await readAttachment("document", 10_000, true);
    expect(attachment.changes.items[0]).toMatchObject({
      kind: "delete",
      author: "田中太郎",
      text: "無催告で",
    });
    expect(attachment.changes.items[0].where).toContain("第12条（解除）");
  });

  it("maps every tracked change type Word reports", async () => {
    const kinds = ["Added", "Deleted", "Formatted", "None"].map((type) => ({
      ...change,
      type,
    }));
    installWord({ selection: "", body: "", paragraphs, markupChanges: kinds });
    const attachment = await readAttachment("document", 10_000, true);
    expect(attachment.changes.items.map((item) => item.kind)).toEqual([
      "insert",
      "delete",
      "format",
      "other",
    ]);
  });

  it("reads nothing when the user did not ask for markup", async () => {
    installWord({
      selection: "",
      body: "",
      paragraphs,
      markupComments: [comment],
      markupChanges: [change],
    });
    const attachment = await readAttachment("document", 10_000, false);
    expect(attachment.markup).toBe(false);
    expect(attachment.comments.items).toHaveLength(0);
    expect(attachment.changes.items).toHaveLength(0);
  });

  it("says tracked changes are unreadable on an older Word instead of reporting none", async () => {
    installWord({ selection: "", body: "", paragraphs, wordApi16: false });
    const attachment = await readAttachment("document", 10_000, true);
    expect(attachment.changes.error).toContain("1.6");
    expect(attachment.changes.items).toHaveLength(0);
  });

  it("keeps the comments when the tracked changes call fails, as a tracked move does", async () => {
    installWord({
      selection: "",
      body: "",
      paragraphs,
      markupComments: [comment],
      changesFail: "GeneralException",
    });
    const attachment = await readAttachment("document", 10_000, true);
    expect(attachment.comments.items).toHaveLength(1);
    expect(attachment.changes.error).toBe("GeneralException");
  });

  it("keeps a comment when only its anchor and replies fail to load", async () => {
    installWord({
      selection: "第2条（代金）",
      body: "",
      paragraphs,
      markupComments: [comment],
      // Sync 1 reads the selection, sync 2 the comment list, sync 3 the extras.
      failSyncAfter: 2,
    });
    const attachment = await readAttachment("selection", 10_000, true);
    expect(attachment.comments.items).toHaveLength(1);
    expect(attachment.comments.items[0].content).toBe("分割払いにしたい。");
    expect(attachment.comments.items[0].anchor).toBe("");
    expect(attachment.comments.items[0].replies).toHaveLength(0);
  });

  it("stops reading comments once they fill their slice of the budget", async () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      ...comment,
      content: `${index} ${"あ".repeat(200)}`,
    }));
    installWord({ selection: "", body: "", paragraphs, markupComments: many });
    const attachment = await readAttachment("document", 2_000, true);
    expect(attachment.comments.truncated).toBe(true);
    expect(attachment.comments.items.length).toBeLessThan(40);
    expect(attachment.comments.items.length).toBeGreaterThan(0);
  });

  it("shortens a long comment rather than dropping it", async () => {
    installWord({
      selection: "",
      body: "",
      paragraphs,
      markupComments: [{ ...comment, content: "あ".repeat(900) }],
    });
    const attachment = await readAttachment("document", 10_000, true);
    expect(attachment.comments.items[0].content).toHaveLength(401);
    expect(attachment.comments.items[0].content.endsWith("…")).toBe(true);
  });
});
