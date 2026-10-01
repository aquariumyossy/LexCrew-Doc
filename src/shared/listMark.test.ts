import { describe, expect, it } from "vitest";
import {
  formatAttachedLine,
  formatSelectionLine,
  isBulletMark,
  isNumberMark,
  listMarkChars,
  stripKnownListString,
  stripListMarks,
  stripWrappedListMark,
  wrapListMark,
} from "./listMark";

describe("wrapListMark", () => {
  it("leaves a non-list paragraph unmarked", () => {
    expect(wrapListMark({ isListItem: false, listString: "1." })).toBe("");
  });

  it("wraps the live list string so it is not body text", () => {
    expect(wrapListMark({ isListItem: true, listString: "1." })).toBe("〔1.〕");
    expect(wrapListMark({ isListItem: true, listString: "(2)" })).toBe("〔(2)〕");
    expect(wrapListMark({ isListItem: true, listString: "ア" })).toBe("〔ア〕");
    expect(wrapListMark({ isListItem: true, listString: "１\u3000" })).toBe("〔１\u3000〕");
  });

  it("says the number exists when Word would not give the string", () => {
    expect(wrapListMark({ isListItem: true, listString: "" })).toBe("〔番号あり〕");
    expect(wrapListMark({ isListItem: true, listString: "  " })).toBe("〔番号あり〕");
  });

  it("canonicalises a bullet so it is not mistaken for a number", () => {
    expect(wrapListMark({ isListItem: true, listString: "•" })).toBe("〔•〕");
    expect(wrapListMark({ isListItem: true, listString: "\uF0B7" })).toBe("〔•〕");
    expect(wrapListMark({ isListItem: true, listString: "・" })).toBe("〔•〕");
    expect(wrapListMark({ isListItem: true, listString: "1.", kind: "bullet" })).toBe("〔•〕");
    expect(isBulletMark({ isListItem: true, listString: "\uF0B7" })).toBe(true);
    expect(isNumberMark({ isListItem: true, listString: "1." })).toBe(true);
  });
});

describe("formatAttachedLine", () => {
  it("keeps the address, then the list mark, then the body", () => {
    expect(formatAttachedLine(12, "甲は乙に委託する。", { isListItem: true, listString: "1." })).toBe(
      "[12] 〔1.〕甲は乙に委託する。"
    );
  });

  it("does not put lenticular brackets on a plain paragraph", () => {
    expect(formatAttachedLine(3, "第1条（目的）", { isListItem: false, listString: "" })).toBe(
      "[3] 第1条（目的）"
    );
  });

  it("counts only the wrapper against the budget, not the body", () => {
    expect(listMarkChars({ isListItem: true, listString: "1." })).toBe("〔1.〕".length);
    expect(listMarkChars({ isListItem: false, listString: "1." })).toBe(0);
  });
});

describe("formatSelectionLine", () => {
  it("marks a selected list item without inventing an address", () => {
    expect(formatSelectionLine("甲は乙に委託する。", { isListItem: true, listString: "1." })).toBe(
      "〔1.〕甲は乙に委託する。"
    );
  });
});

describe("stripListMarks", () => {
  it("drops the wrapper so search can see the body", () => {
    expect(stripWrappedListMark("〔1.〕甲は乙に委託する。")).toBe("甲は乙に委託する。");
    expect(stripListMarks("〔1.〕甲は乙に委託する。")).toBe("甲は乙に委託する。");
  });

  it("drops a copied live mark when that paragraph's string is known", () => {
    expect(stripKnownListString("1. 甲は乙に委託する。", "1.")).toBe("甲は乙に委託する。");
    expect(stripListMarks("1. 甲は乙に委託する。", "1.")).toBe("甲は乙に委託する。");
    expect(stripKnownListString("１\u3000甲は乙に委託する。", "１\u3000")).toBe("甲は乙に委託する。");
  });

  it("does not guess a mark when the paragraph is unknown", () => {
    expect(stripListMarks("1. 甲は乙に委託する。")).toBe("1. 甲は乙に委託する。");
  });

  it("does not treat body that starts with 1. as a mark for a different paragraph", () => {
    expect(stripKnownListString("1. 甲は乙に委託する。", "(1)")).toBe("1. 甲は乙に委託する。");
  });

  it("leaves body that happens to contain lenticular brackets after the wrapper", () => {
    expect(stripWrappedListMark("第1条")).toBe("第1条");
  });
});
