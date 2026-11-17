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
    // 个 is a JIS X 0208 kanji, so it stays. 这问題 are not.
    expect(foreignChars("这个合同的问题")).toEqual(["这", "问", "题"]);
    expect(foreignChars("门发经问题")).toEqual(["门", "发", "经", "问", "题"]);
    // 从 is JIS X 0208. The other simplified forms are not.
    expect(foreignChars("为了对从开关")).toEqual(["为", "对", "开", "关"]);
    expect(foreignChars("们这说话门问题")).toEqual(["们", "这", "说", "话", "门", "问", "题"]);
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
    expect(isJapaneseHan("个".codePointAt(0)!)).toBe(true);
  });

  it("ignores kana, punctuation, latin and greek", () => {
    expect(foreignChars("はい。OK 123 「引用」")).toEqual([]);
    expect(foreignChars("α版　μm　ＡＩツール　ｱｲｳ")).toEqual([]);
    expect(foreignChars("https://example.com/a?b=1")).toEqual([]);
    expect(isCjkIdeograph("あ".codePointAt(0)!)).toBe(false);
  });

  it("dedupes in first-seen order across parts", () => {
    expect(foreignChars("这这", "问这")).toEqual(["这", "问"]);
  });

  it("keeps JIS X 0208 kanji that look simplified, and still flags the rest", () => {
    expect(isJapaneseHan("個".codePointAt(0)!)).toBe(true);
    expect(isJapaneseHan("个".codePointAt(0)!)).toBe(true);
    expect(isJapaneseHan("无".codePointAt(0)!)).toBe(true);
    expect(isJapaneseHan("从".codePointAt(0)!)).toBe(true);
    expect(isJapaneseHan("广".codePointAt(0)!)).toBe(true);
    for (const ch of ["们", "这", "说", "话", "门", "问", "题"]) {
      expect(isJapaneseHan(ch.codePointAt(0)!)).toBe(false);
    }
  });
});

describe("foreignCharNotice", () => {
  it("returns null when nothing is foreign", () => {
    expect(foreignCharNotice("条項を点検しました。")).toBeNull();
  });

  it("lists the glyphs for the chat pane", () => {
    expect(foreignCharNotice("这个条款。")).toBe("日本語で用いない文字: 这");
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
    ).toBe("日本語で用いない文字: 这");
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

  it("accepts JIS and CP932 names and still rejects simplified forms", () => {
    expect(
      foreignCharToolError({
        name: "replace_selection",
        args: { text: "甲は髙橋および𠮷田とする。" },
      })
    ).toBeNull();
    const error = foreignCharToolError({
      name: "replace_selection",
      args: { text: "他们问这个问题。" },
    });
    expect(error).toContain("这");
    expect(error).toContain("们");
  });
});

describe("JIS and CP932 allowlist", () => {
  it("keeps party names and the JIS kanji that were missing", () => {
    expect(foreignChars("髙橋")).toEqual([]);
    expect(foreignChars("𠮷田")).toEqual([]);
    expect(foreignChars("姜砺薮疱碍涛")).toEqual([]);
    expect(isJapaneseHan(0x9ad9)).toBe(true);
    expect(isJapaneseHan(0x20bb7)).toBe(true);
    for (const ch of ["姜", "砺", "薮", "疱", "痒", "碍", "辟", "禀", "蛎", "涛", "洒", "杰", "范", "梼"]) {
      expect(isJapaneseHan(ch.codePointAt(0)!), ch).toBe(true);
    }
  });

  it("still detects simplified forms and hangul", () => {
    expect(foreignChars("这们")).toEqual(["这", "们"]);
    expect(foreignChars("기타")).toEqual(["기", "타"]);
    for (const ch of ["们", "这", "说", "话", "门", "问", "题"]) {
      expect(isJapaneseHan(ch.codePointAt(0)!), ch).toBe(false);
    }
  });
});
