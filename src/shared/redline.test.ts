import { describe, expect, it } from "vitest";
import { alignReviewed, opHitsDeletion, planRedline, type ReviewedAlignment } from "./redline";

function tokens(text: string): string[] {
  return Array.from(text);
}

function ops(before: string, after: string) {
  return planRedline(tokens(before), tokens(after));
}

describe("planRedline", () => {
  it("keeps a long clause around one replacement", () => {
    expect(ops("甲と乙は、期間経過後2年間は、第三者に開示してはならない。", "甲と乙は、期間経過後においても、第三者に開示してはならない。")).toEqual([
      { start: 10, end: 14, text: "においても" },
    ]);
  });

  it("leaves a particle that is as long as the edits beside it", () => {
    expect(ops("甲は乙", "丙は丁")).toEqual([
      { start: 0, end: 1, text: "丙" },
      { start: 2, end: 3, text: "丁" },
    ]);
  });

  it("absorbs a one-character bridge between longer edits", () => {
    expect(ops("AAAAあBBBB", "CCCCあDDDD")).toEqual([{ start: 0, end: 9, text: "CCCCあDDDD" }]);
  });

  it("keeps two edits apart when the gap is longer than either", () => {
    expect(ops("乙に対し報酬", "丙に対し代金")).toEqual([
      { start: 0, end: 1, text: "丙" },
      { start: 4, end: 6, text: "代金" },
    ]);
  });

  it("returns nothing when the tokens match", () => {
    expect(ops("同じ文です。", "同じ文です。")).toEqual([]);
  });

  it("inserts and deletes", () => {
    expect(ops("報酬を支払う", "報酬を翌月末までに支払う")).toEqual([
      { start: 3, end: 3, text: "翌月末までに" },
    ]);
    expect(ops("前削除後", "前後")).toEqual([{ start: 1, end: 3, text: "" }]);
  });

  it("keeps a surrogate pair as one token", () => {
    expect(ops("𠮷田", "吉田")).toEqual([{ start: 0, end: 1, text: "吉" }]);
  });
});

describe("alignReviewed", () => {
  it("maps each accepted character past a deletion", () => {
    expect(alignReviewed(tokens("甲は乙削除に支払う。"), "甲は乙に支払う。")).toEqual({
      rawIndex: [0, 1, 2, 5, 6, 7, 8, 9],
      ambiguous: [],
    });
  });

  it("marks a repeated character next to the same deleted character", () => {
    expect(alignReviewed(tokens("あののう"), "あのう")).toEqual({
      rawIndex: [0, -1, 3],
      ambiguous: [{ start: 1, end: 2 }],
    });
    expect(alignReviewed(tokens("ののの"), "のの")).toEqual({
      rawIndex: [-1, -1],
      ambiguous: [{ start: 0, end: 2 }],
    });
  });

  it("returns an identity map when nothing was deleted", () => {
    expect(alignReviewed(tokens("甲は支払う。"), "甲は支払う。")).toEqual({
      rawIndex: [0, 1, 2, 3, 4, 5],
      ambiguous: [],
    });
  });

  it("keeps a surrogate pair on one raw index", () => {
    expect(alignReviewed(["𠮷", "削", "田"], "𠮷田")).toEqual({
      rawIndex: [0, 2],
      ambiguous: [],
    });
  });

  it("returns null when the accepted text is not the raw text with deletions removed", () => {
    expect(alignReviewed(tokens("支払額は100万円とする。"), "支払額は<100万円>とする。")).toBeNull();
  });

  it("treats a span across a deletion as a hit and a neighbor edit as clear", () => {
    const alignment = alignReviewed(tokens("甲は乙削除に支払う。"), "甲は乙に支払う。") as ReviewedAlignment;
    expect(opHitsDeletion({ start: 2, end: 4, text: "丙へ" }, alignment, 10)).toBe(true);
    expect(opHitsDeletion({ start: 0, end: 1, text: "丙" }, alignment, 10)).toBe(false);
    expect(opHitsDeletion({ start: 4, end: 7, text: "渡す" }, alignment, 10)).toBe(false);
    expect(opHitsDeletion({ start: 3, end: 3, text: "へ" }, alignment, 10)).toBe(false);
  });

  it("treats an edit of an ambiguous character as a hit", () => {
    const alignment = alignReviewed(tokens("あののう"), "あのう") as ReviewedAlignment;
    expect(opHitsDeletion({ start: 1, end: 2, text: "が" }, alignment, 4)).toBe(true);
    expect(opHitsDeletion({ start: 0, end: 1, text: "い" }, alignment, 4)).toBe(false);
    expect(opHitsDeletion({ start: 1, end: 1, text: "が" }, alignment, 4)).toBe(true);
  });

  it("treats an insertion into a fully deleted paragraph as a hit", () => {
    const alignment = alignReviewed(tokens("削除"), "") as ReviewedAlignment;
    expect(opHitsDeletion({ start: 0, end: 0, text: "甲" }, alignment, 2)).toBe(true);
  });
});
