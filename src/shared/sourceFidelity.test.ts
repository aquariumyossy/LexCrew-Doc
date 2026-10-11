import { describe, expect, it } from "vitest";
import { droppedNumbers, unsourcedFacts } from "./sourceFidelity";

const BOXES = [
  "住　所：神奈川県藤沢市大鋸1034-3",
  "物件名：ドルチェA棟102",
  "電気：16897.5kWh\t動き：動いている",
  "ガス：4452.415m^3\t動き：動いている",
  "相対した人物（被告との関係）：オオタ　ツクモ（　弟　）",
  "被告\t電話番号：090-8306-3723",
].join("\n");

describe("unsourcedFacts", () => {
  it("lists the numbers, katakana and Latin words of an invented rewrite", () => {
    expect(
      unsourcedFacts(
        [
          "①　所在　神奈川県藤沢市用田593番地",
          "②　物件名　藤沢ハイツ102号",
          "③　表札　有　TOYAMA",
          "ア　電気　1234.5kWh",
          "（１）勤務先　株式会社ニデック",
        ],
        BOXES
      )
    ).toEqual(["593", "ハイツ", "TOYAMA", "1234.5", "ニデック"]);
  });

  it("passes a rewrite whose facts all come from the source, in any width or unit spelling", () => {
    expect(
      unsourcedFacts(
        [
          "（１）　住所：神奈川県藤沢市大鋸１０３４－３",
          "（２）　物件名：ドルチェＡ棟１０２",
          "①　電気：16897.5kWh、動いている。",
          "②　ガス：4452.415㎥、動いている。",
          "（２）　相対した人物：オオタ　ツクモ（弟）",
          "①　電話番号：090-8306-3723",
        ],
        BOXES
      )
    ).toEqual([]);
  });

  it("does not count the outline number at the head of a line", () => {
    expect(
      unsourcedFacts(["（１２）　電気：16897.5kWh", "１０．ガス", "第１１　電話"], BOXES)
    ).toEqual([]);
    expect(unsourcedFacts(["（１２）　電気：12kWh"], BOXES)).toEqual(["12"]);
  });

  it("keeps a katakana item mark apart from the word after it", () => {
    expect(unsourcedFacts(["イ　ガス：4452.415㎥", "ウ　電気"], `${BOXES}\nガス`)).toEqual([]);
  });

  it("names each missing word once", () => {
    expect(unsourcedFacts(["ニデックに電話", "ニデックの所在"], BOXES)).toEqual(["ニデック"]);
  });
});

describe("droppedNumbers", () => {
  it("names the number a rewrite lost from the source", () => {
    expect(
      droppedNumbers(BOXES, [
        "住所は、神奈川県藤沢市大鋸1034-3、物件名はドルチェA棟1034-3ドルチェA棟です。",
        "電気メーターは16897.5kWhで、動いています。ガスメーターは4452.415㎥で、動いています。",
        "オオタ　ツクモ（被告の弟）と相対しました。",
        "電話番号は090-8306-3723で、停止している。",
      ])
    ).toEqual(["102"]);
  });

  it("finds a number written in another width, and skips single digits and outline heads", () => {
    expect(
      droppedNumbers("（１２）　物件名：ドルチェＡ棟１０２\n第１回目調査", [
        "物件名：ドルチェA棟102",
      ])
    ).toEqual([]);
  });
});
