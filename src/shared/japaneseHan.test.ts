import { describe, expect, it } from "vitest";
import {
  authoredToolTexts,
  foreignCharNotice,
  foreignCharNoticeForAssistant,
  foreignCharToolError,
  foreignChars,
  isCjkIdeograph,
  isJapaneseHan,
} from "./japaneseHan";

describe("foreignChars", () => {
  it("ignores Japanese legal prose", () => {
    expect(foreignChars("第1条　甲は乙に対し、瑕疵を理由に契約を解除できる。")).toEqual([]);
    expect(foreignChars("損害賠償　原告　被告　謄本　捺印")).toEqual([]);
  });

  it("flags simplified Chinese that is not Japanese running text", () => {
    expect(foreignChars("这个合同的问题")).toEqual(["这", "个", "问", "题"]);
    expect(foreignChars("门发经问题")).toEqual(["门", "发", "经", "问", "题"]);
    expect(foreignChars("为了对从开关")).toEqual(["为", "对", "从", "开", "关"]);
  });

  it("flags hangul, which slipped into a contract as 기타", () => {
    expect(foreignChars("権利侵害の主張 기타 クレームについては")).toEqual(["기", "타"]);
    expect(foreignChars("계약")).toEqual(["계", "약"]);
    expect(foreignChars("ﾯ")).toEqual(["ﾯ"]);
  });

  it("flags other scripts a drifting model reaches for", () => {
    expect(foreignChars("Привет")).toEqual(["П", "р", "и", "в", "е", "т"]);
    expect(foreignChars("สัญญา").length).toBeGreaterThan(0);
  });

  it("flags Kangxi radicals that look like kanji but break search", () => {
    expect(foreignChars("⼀")).toEqual(["⼀"]);
    expect(foreignChars("一")).toEqual([]);
  });

  it("keeps shared shinjitai and Japanese kyujitai", () => {
    expect(foreignChars("国会学体来与門発國學")).toEqual([]);
  });

  it("keeps JIS X 0208 拡張新字体 that Unihan lists as simplified Chinese", () => {
    expect(foreignChars("嘘をつく")).toEqual([]);
    expect(foreignChars("侠客の躯を掴み、麹と蝉と泪")).toEqual([]);
    expect(isJapaneseHan("嘘".codePointAt(0)!)).toBe(true);
    expect(isJapaneseHan("噓".codePointAt(0)!)).toBe(true);
    expect(isJapaneseHan("个".codePointAt(0)!)).toBe(false);
  });

  it("ignores kana, punctuation, latin and greek", () => {
    expect(foreignChars("はい。OK 123 「引用」")).toEqual([]);
    expect(foreignChars("α版　μm　ＡＩツール　ｱｲｳ")).toEqual([]);
    expect(foreignChars("https://example.com/a?b=1")).toEqual([]);
    expect(isCjkIdeograph("あ".codePointAt(0)!)).toBe(false);
  });

  it("dedupes in first-seen order across parts", () => {
    expect(foreignChars("这这", "个这")).toEqual(["这", "个"]);
  });

  it("treats 个 as foreign even though it has a JIS code", () => {
    expect(isJapaneseHan("個".codePointAt(0)!)).toBe(true);
    expect(isJapaneseHan("个".codePointAt(0)!)).toBe(false);
  });
});

describe("foreignCharNotice", () => {
  it("returns null when nothing is foreign", () => {
    expect(foreignCharNotice("条項を点検しました。")).toBeNull();
  });

  it("lists the glyphs for the chat pane", () => {
    expect(foreignCharNotice("这个条款。")).toBe("日本語で用いない文字: 这、个");
    expect(foreignCharNotice("主張 기타 クレーム")).toBe("日本語で用いない文字: 기、타");
  });

  it("also reads model-authored tool arguments", () => {
    expect(
      foreignCharNoticeForAssistant("", [
        {
          function: {
            name: "insert_blocks",
            arguments: JSON.stringify({ blocks: [{ type: "body", text: "这个条款。" }] }),
          },
        },
      ])
    ).toBe("日本語で用いない文字: 这、个");
  });
});

describe("foreignCharToolError", () => {
  it("scans insert_blocks text and labels", () => {
    const error = foreignCharToolError({
      name: "insert_blocks",
      args: { blocks: [{ type: "clause", label: "第1条", text: "这是定义。" }] },
    });
    expect(error).toContain("这");
    expect(error).toContain("書き直してください");
    expect(
      authoredToolTexts({
        name: "insert_blocks",
        args: { blocks: [{ type: "body", text: "本文", label: "見出し" }] },
      })
    ).toEqual(["見出し", "本文"]);
  });

  it("refuses the hangul that reached the document before", () => {
    const error = foreignCharToolError({
      name: "insert_blocks",
      args: {
        blocks: [
          {
            type: "item",
            text: "５　権利侵害の主張 기타 クレームについては、乙は責任を負いません。",
          },
        ],
      },
    });
    expect(error).toContain("기");
    expect(error).toContain("타");
  });

  it("ignores search and citation payloads", () => {
    expect(foreignCharToolError({ name: "search", args: { q: "最高人民法院" } })).toBeNull();
    expect(
      foreignCharToolError({
        name: "insert_citation",
        args: { title: "判决书", url: "http://x", snippet: "这个", as: "comment" },
      })
    ).toBeNull();
  });
});
