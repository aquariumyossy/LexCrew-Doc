import { describe, expect, it } from "vitest";
import {
  MAX_REPLACE_MATCHES,
  compileParagraphMatcher,
  countTextMatches,
  planTextMatches,
  replacePatternError,
  type ParagraphFact,
} from "./bulkFormat";

const MAX_LITERAL = 255;

function fact(partial: Partial<ParagraphFact> & Pick<ParagraphFact, "text">): ParagraphFact {
  return {
    style: "標準",
    styleBuiltIn: "Normal",
    outlineLevel: 10,
    list: "none",
    inTable: false,
    ...partial,
  };
}

describe("planTextMatches", () => {
  it("finds every literal hit and numbers repeated slices", () => {
    expect(planTextMatches("甲は甲に委託する。", { find: "甲" })).toEqual([
      { start: 0, end: 1, text: "甲", occurrence: 0 },
      { start: 2, end: 3, text: "甲", occurrence: 1 },
    ]);
  });

  it("folds case unless matchCase is set", () => {
    expect(planTextMatches("Foo foo FOO", { find: "foo" }).map((hit) => hit.text)).toEqual([
      "Foo",
      "foo",
      "FOO",
    ]);
    expect(
      planTextMatches("Foo foo", { find: "foo", matchCase: true }).map((hit) => hit.text)
    ).toEqual(["foo"]);
  });

  it("keeps a regex inside one paragraph and can require a whole word", () => {
    const hits = planTextMatches("第1条（目的）と第12条の2", { find: "第\\d+条", regex: true });
    expect(hits.map((hit) => hit.text)).toEqual(["第1条", "第12条"]);

    expect(
      planTextMatches("契約、および契約書", { find: "契約", wholeWord: true }).map(
        (hit) => hit.text
      )
    ).toEqual(["契約"]);
    expect(planTextMatches("契約書の契約", { find: "契約", wholeWord: true })).toHaveLength(0);
    expect(planTextMatches("foo bar foobar", { find: "foo", wholeWord: true })).toHaveLength(1);
    expect(planTextMatches("第1条（目的）", { find: "第1条", wholeWord: true })).toHaveLength(1);
  });

  it("rejects an empty find, a broken pattern, and a literal that Word cannot search", () => {
    expect(replacePatternError({ find: "" }, MAX_LITERAL)).toMatch(/空/);
    expect(replacePatternError({ find: "(", regex: true }, MAX_LITERAL)).toMatch(/不正/);
    expect(replacePatternError({ find: "あ".repeat(MAX_LITERAL + 1) }, MAX_LITERAL)).toMatch(
      /字まで/
    );
    expect(replacePatternError({ find: "甲" }, MAX_LITERAL)).toBeNull();
  });

  it("stops a pattern that matches more than the cap", () => {
    const texts = ["甲".repeat(MAX_REPLACE_MATCHES + 1)];
    const counted = countTextMatches(texts, { find: "甲" });
    expect(counted).toMatchObject({ error: expect.stringMatching(/超えています/) });
  });
});

describe("compileParagraphMatcher", () => {
  const rows = [
    fact({ text: "請求の趣旨", style: "見出し 1", styleBuiltIn: "Heading1", outlineLevel: 1 }),
    fact({ text: "", style: "標準" }),
    fact({ text: "甲は委託する。", list: "bullet" }),
    fact({ text: "乙は受託する。", list: "numbered" }),
    fact({ text: "表の中", inTable: true }),
    fact({ text: "第6条を準用する。" }),
  ];

  function picked(select: Parameters<typeof compileParagraphMatcher>[0]): string[] {
    const match = compileParagraphMatcher(select);
    return rows.filter(match).map((row) => row.text);
  }

  it("matches nothing when no condition is set", () => {
    expect(picked({})).toEqual([]);
  });

  it("ands style, outline, text, emptiness, lists, and table cells", () => {
    expect(picked({ style: "見出し 1" })).toEqual(["請求の趣旨"]);
    expect(picked({ style: "heading1" })).toEqual(["請求の趣旨"]);
    expect(picked({ outlineLevel: 1 })).toEqual(["請求の趣旨"]);
    expect(picked({ empty: true })).toEqual([""]);
    expect(picked({ empty: false, text: "委託" })).toEqual(["甲は委託する。"]);
    expect(picked({ list: "bullet" })).toEqual(["甲は委託する。"]);
    expect(picked({ list: "numbered" })).toEqual(["乙は受託する。"]);
    expect(picked({ list: "none", text: "準用" })).toEqual(["第6条を準用する。"]);
    expect(picked({ tableCell: true })).toEqual(["表の中"]);
    expect(picked({ text: "第\\d+条", regex: true })).toEqual(["第6条を準用する。"]);
    expect(picked({ style: "見出し 1", empty: true })).toEqual([]);
  });
});
