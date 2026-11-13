import { describe, expect, it } from "vitest";
import {
  markAnswer,
  markDelivered,
  markUnverified,
  verifiedFromDelivered,
  verifiedFromToolOutput,
  type VerifiedCite,
} from "./statuteMark";

function verified(names: string[], key: string): VerifiedCite {
  return { names, key };
}

describe("markUnverified", () => {
  it("marks citations whose text was not fetched and leaves the fetched ones", () => {
    const got = markUnverified("民法第555条は売買です。民法第1条は基本原則です。方法第1条は関係ありません。契約書第5条は条名だけです。", [
      verified(["民法"], "555"),
    ]);
    expect(got).toContain("民法第555条は売買");
    expect(got).not.toContain("民法第555条（要確認）");
    expect(got).toContain("民法第1条（要確認）");
    expect(got).toContain("方法第1条は関係");
    expect(got).not.toContain("方法第1条（要確認）");
    expect(got).toContain("契約書第5条は");
    expect(got).not.toContain("契約書第5条（要確認）");
    const again = markUnverified(got, [verified(["民法"], "555")]);
    expect(again.match(/（要確認）/g)?.length).toBe(1);
  });

  it("accepts an abbreviation and a branch number that were fetched", () => {
    const labor = markUnverified("労基法第36条は時間外です。労基法第37条は割増です。", [
      verified(["労働基準法", "労基法"], "36"),
    ]);
    expect(labor).toContain("労基法第36条は");
    expect(labor).toContain("労基法第37条（要確認）");
    const branched = markUnverified("民法第548条の2は定型約款です。", [verified(["民法"], "548_2")]);
    expect(branched).not.toContain("要確認");
  });

  it("follows the law in front of the article, including 同法 and 附則", () => {
    const known = [
      verified(["民法"], "32_4"),
      verified(["個人情報の保護に関する法律", "個人情報保護法"], "27"),
      verified(["民法"], "1"),
      verified(["民法"], "548_2"),
    ];
    expect(markUnverified("同法第32条の4第1項は適用されます。", known)).not.toContain("要確認");
    expect(markUnverified("個人情報の保護に関する法律第27条は第三者提供です。", known)).not.toContain(
      "要確認"
    );
    const pair = markUnverified("民法第1条及び第2条。", known);
    expect(pair).toContain("第2条（要確認）");
    expect(pair).not.toContain("第1条（要確認）");
    expect(markUnverified("改正民法第548条の2は定型約款です。", known)).not.toContain("要確認");
    expect(markUnverified("民法附則第1条。", [verified(["民法"], "1")])).toContain("附則第1条（要確認）");
    expect(markUnverified("民法附則第1条。", [verified(["民法"], "s1")])).toContain("要確認");
    for (const sample of [
      "民法附則第1条",
      "附則3条",
      "民法附則（平成二十九年法律第四十四号）第1条",
      "附則（平成29年法律第44号）第1条",
      "民法附則の第1条",
    ]) {
      expect(markUnverified(sample, [verified(["民法"], "1")]), sample).toContain("（要確認）");
    }
    const bare = markUnverified("根拠は民法555条は売買です。民法1条は別です。", known);
    expect(bare).toContain("555条（要確認）");
    expect(bare).toContain("民法1条は");
    expect(bare).not.toContain("1条（要確認）");
    expect(markUnverified("根拠は民法第548の2", known)).not.toContain("要確認");
    expect(markUnverified("根拠は民法第548の2", [])).toContain("第548の2（要確認）");
  });

  it("does not treat a truncated tool result as fetched", () => {
    const full = "確認済み: 民法 第555条\n\n【民法 第555条】\n見出し: 売買\n本文です。\n";
    expect(verifiedFromDelivered(full)).toHaveLength(1);
    expect(verifiedFromToolOutput(full)[0]).toMatchObject({ key: "555", names: ["民法"] });
    expect(verifiedFromDelivered("（文脈の上限に達したため、この結果は省略しました）")).toEqual([]);
    const cut =
      "確認済み: 民法 第555条\n確認済み: 民法 第1条\n\n【民法 第555条】\n本文です。\n\n【民法 第1条】\n途中…（長いので省略しました）";
    const kept = verifiedFromDelivered(cut);
    expect(kept.map((item) => item.key)).toEqual(["555"]);
    const same =
      "確認済み: 民法 第1条\n確認済み: 会社法 第1条\n\n【民法 第1条】\n全文です。\n\n【会社法 第1条】\n途中…（長いので省略しました）";
    const keptLaw = verifiedFromDelivered(same);
    expect(keptLaw).toEqual([{ names: ["民法"], key: "1" }]);
  });

  it("marks an answer from the tool text the model actually received", () => {
    const tool = "確認済み: 民法|労基法 第36条\n\n【民法 第36条】\n本文です。\n";
    const marked = markAnswer("労基法第36条は確認した。民法第1条はまだ。", [tool]);
    expect(marked).toContain("労基法第36条は");
    expect(marked).toContain("民法第1条（要確認）");
  });

  it("does not treat a search line or a truncated law_article result as verified", () => {
    const searchOnly = markDelivered("民法第1条は原則です。", [
      { name: "search", content: "確認済み: 民法 第1条\n\n【民法 第1条】\n本文\n" },
    ]);
    expect(searchOnly).toContain("民法第1条（要確認）");
    const cut = markDelivered("民法第1条は原則です。", [
      {
        name: "law_article",
        content: "確認済み: 民法 第1条\n\n【民法 第1条】\n途中…（長いので省略しました）",
      },
    ]);
    expect(cut).toContain("（要確認）");
  });

  it("marks an unbound or ambiguous 同法 and keeps real law names", () => {
    const ambiguous = markUnverified("同法第1条。", [
      verified(["民法"], "1"),
      verified(["会社法"], "1"),
    ]);
    expect(ambiguous).toContain("（要確認）");
    const named = markUnverified("民法第1条。会社法は重要である。同法第2条は法人です。", [
      verified(["民法"], "1"),
      verified(["会社法"], "2"),
    ]);
    expect(named).not.toContain("同法第2条（要確認）");
    expect(named).not.toContain("第2条（要確認）");
    for (const name of ["労働組合法", "小切手法", "行手法", "取適法", "医療法"]) {
      const marked = markUnverified(`${name}第1条。`, []);
      expect(marked, name).toContain("（要確認）");
    }
    const old = markUnverified("旧民法第1条。", [verified(["民法"], "1")]);
    expect(old).toContain("（要確認）");
  });
});
