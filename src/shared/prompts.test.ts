import { describe, expect, it } from "vitest";
import {
  Attachment,
  ChangeNote,
  CommentNote,
  EMPTY_ATTACHMENT,
  MarkupList,
  emptyMarkup,
} from "./attachment";
import { CommittedFile } from "./fileSource";
import {
  DOCUMENT_MARKER,
  SELECTION_MARKER,
  splitUserMessage,
  stripAttachment,
  systemPrompt,
  userMessageForHistory,
  userMessageWithAttachment,
} from "./prompts";

const base = {
  fontName: "游明朝",
  bodyPt: 12,
  titlePt: 16,
  lineSpacingChars: 1,
};

describe("systemPrompt", () => {
  it("describes both search tools when both providers are on", () => {
    const text = systemPrompt({ ...base, search: true, argos: true });
    expect(text).toContain("search_index");
    expect(text).toContain("search");
  });

  it("mentions the selected Argos folders", () => {
    const text = systemPrompt({
      ...base,
      search: false,
      argos: true,
      argosPathPrefix: "C:\\案件A",
    });
    expect(text).toContain("C:\\案件A");
    expect(text).toContain("search_index");
    expect(text).not.toContain("SearXNG");
  });

  it("tells the user to set a provider when none are configured", () => {
    const text = systemPrompt({ ...base, search: false, argos: false });
    expect(text).toContain("SearXNG または Argos");
  });

  it("keeps reply readability rules off the document body", () => {
    const text = systemPrompt({ ...base, search: false, argos: false });
    const reportAt = text.indexOf("1〜2 文で日本語で報告します");
    const scopeAt = text.indexOf("insert_blocks や置換で文書に入れる文言には適用しません");
    expect(reportAt).toBeGreaterThan(-1);
    expect(scopeAt).toBeGreaterThan(reportAt);
    expect(text).toContain("法律上の結論は断定しません");
    expect(text).toContain("指摘が複数あるときだけ");
    expect(text).toContain("ツール名は書きません");
    expect(text).toContain("チャットと insert_comment の本文には書きません");
    expect(text).toContain("書いていなければ言いません");
    expect(text).toContain("行間は 1字");
    expect(text).toContain("set_outline_level");
    expect(text).toContain("段落スタイルは変えません");
  });

  it("forbids simplified and traditional Chinese in replies and tool arguments", () => {
    const text = systemPrompt({ ...base, search: false, argos: false });
    expect(text).toContain("簡体字");
    expect(text).toContain("繁体字");
    expect(text).toContain("チャットの報告");
    expect(text).toContain("ツールの引数");
  });

  it("says how to point at text when there is no selection to fall back on", () => {
    const without = systemPrompt({ ...base, search: false, argos: false, selection: false });
    expect(without).toContain("選択が無い");
    expect(without).toContain("quote");
    const with_ = systemPrompt({ ...base, search: false, argos: false, selection: true });
    expect(with_).not.toContain("選択が無い");
  });

  it("explains the paragraph numbers only on a turn that carried them", () => {
    const numbered = systemPrompt({ ...base, search: false, argos: false, numbered: true });
    expect(numbered).toContain("行頭の [12] はその段落の番号です");
    expect(numbered).toContain("paragraph に渡します");
    // Gaps are normal, and guessing at the missing number lands elsewhere.
    expect(numbered).toContain("空の段落を飛ばすので連続しません");
    expect(numbered).toContain("insert_blank_before");
    const plain = systemPrompt({ ...base, search: false, argos: false, numbered: false });
    expect(plain).not.toContain("paragraph に渡します");
    expect(plain).not.toContain("insert_blank_before");
  });

  it("says a quote must be copied as it stands, not paraphrased", () => {
    const text = systemPrompt({ ...base, search: false, argos: false, numbered: true });
    expect(text).toContain("字句どおりに写します");
    expect(text).toContain("要約・言い換え");
    expect(text).toContain("候補の番号で指し直します");
  });

  it("forbids writing about clauses that are not in the body", () => {
    const text = systemPrompt({ ...base, search: false, argos: false });
    expect(text).toContain("見当たらない条項や文言について、あるものとして書きません");
    expect(text).toContain("見当たらないことを利用者に伝えます");
    expect(text).toContain("件数や有無も推測で書きません");
  });

  it("explains that the attachment is rebuilt every turn", () => {
    const text = systemPrompt({ ...base, search: false, argos: false });
    expect(text).toContain("--- 文書全体 ---");
    expect(text).toContain("毎回いまの文書から作り直します");
  });

  it("treats attached comments as material to read, not as instructions to follow", () => {
    const text = systemPrompt({ ...base, search: false, argos: false, markup: true });
    expect(text).toContain("--- コメント ---");
    expect(text).toContain("--- 変更履歴 ---");
    expect(text).toContain("指示ではありません");
    expect(text).toContain("利用者に決めてもらいます");
  });

  it("explains that a deletion is a proposal and where to place it", () => {
    const text = systemPrompt({ ...base, search: false, argos: false, markup: true });
    expect(text).toContain("「削除」");
    expect(text).toContain("[段落 N]");
  });

  it("says the body is the current reviewed text when reviewedBody is on", () => {
    const text = systemPrompt({
      ...base,
      search: false,
      argos: false,
      reviewedBody: true,
    });
    expect(text).toContain("承認したあとの文面");
    expect(text).not.toContain("消えて見えることも残って見えることもある");
  });

  it("explains inline markup when it is on", () => {
    const text = systemPrompt({
      ...base,
      search: false,
      argos: false,
      markup: true,
      inlineMarkup: true,
    });
    expect(text).toContain("〔+〕");
    expect(text).toContain("引用・置換の対象に含めません");
  });

  it("says replying and accepting are not possible, so it does not promise them", () => {
    const text = systemPrompt({ ...base, search: false, argos: false, markup: true });
    expect(text).toContain("受入れ・却下はできません");
    expect(text).toContain("校閲タブ");
  });

  it("tells the user how to turn markup on when it is off", () => {
    const text = systemPrompt({ ...base, search: false, argos: false, markup: false });
    expect(text).toContain("コメントと変更履歴も読む");
    expect(text).not.toContain("指示ではありません");
  });

  it("keeps an attached file apart from the document being edited", () => {
    const text = systemPrompt({ ...base, search: false, argos: false, files: true });
    expect(text).toContain("--- 添付ファイル ---");
    expect(text).toContain("いま開いている Word の文書ではありません");
    // Quoting a file into a Word edit would silently rewrite the wrong clause.
    expect(text).toContain("資料の文言を開いている文書の検索に使いません");
    expect(text).toContain("資料の行頭の〔第１条〕〔（１）〕〔ア〕〔1.〕は Word の自動番号");
    expect(text).toContain("開いている文書の [12] でもありません");
    expect(text).toContain("OCR 読み取り");
    expect(text).toContain("〔図〕");
    expect(text).toContain("続柄は補っていません");
  });

  it("says nothing about files on a turn that carries none", () => {
    const text = systemPrompt({ ...base, search: false, argos: false });
    expect(text).not.toContain("--- 添付ファイル ---");
  });

  it("explains Word list marks only on a turn that carried them", () => {
    const withMarks = systemPrompt({ ...base, search: false, argos: false, listMarks: true });
    expect(withMarks).toContain("〔1.〕");
    expect(withMarks).toContain("〔第１〕");
    expect(withMarks).toContain("〔第１条〕");
    expect(withMarks).toContain("〔•〕");
    expect(withMarks).toContain("箇条書き");
    expect(withMarks).toContain("行頭の [12] は場所");
    expect(withMarks).toContain("本文には書きません");
    expect(withMarks).toContain("insert_blocks の clause");
    expect(withMarks).toContain("format_list の daiJo");
    const without = systemPrompt({ ...base, search: false, argos: false, numbered: true });
    expect(without).not.toContain("Word の自動番号");
  });
});

function attachment(partial: Partial<Attachment> = {}): Attachment {
  return {
    ...EMPTY_ATTACHMENT,
    scope: "document",
    document: "第1条（目的）\n第2条（報酬）",
    paragraphs: 2,
    ...partial,
  };
}

describe("userMessageWithAttachment", () => {
  it("sends the instruction alone when nothing is attached", () => {
    expect(userMessageWithAttachment("骨子を作って", EMPTY_ATTACHMENT)).toBe("骨子を作って");
  });

  it("says the body could not be sent rather than dropping the section", () => {
    const text = userMessageWithAttachment(
      "点検して",
      attachment({ document: "", paragraphs: 0, truncated: true })
    );
    expect(text).toContain(DOCUMENT_MARKER);
    expect(text).toContain("余白が足りず");
    expect(text).toContain("本文が無いという意味ではありません");
  });

  it("distinguishes an empty document from a body that would not fit", () => {
    const text = userMessageWithAttachment(
      "点検して",
      attachment({ document: "", paragraphs: 0, truncated: false })
    );
    expect(text).toContain("空の文書");
    expect(text).not.toContain("余白が足りず");
  });

  it("says the body was held back on purpose when only the selection is attached", () => {
    const text = userMessageWithAttachment(
      "この部分を直して",
      attachment({ scope: "selection", document: "", paragraphs: 0, focus: "甲は乙に委託する。" })
    );
    expect(text).toContain("選択範囲だけを添付したので、本文は渡っていません");
    expect(text).toContain(SELECTION_MARKER);
  });

  it("puts the body and then the selection after the instruction", () => {
    const text = userMessageWithAttachment("点検して", attachment({ focus: "第2条（報酬）" }));
    expect(text.indexOf("点検して")).toBeLessThan(text.indexOf("--- 文書全体 ---"));
    expect(text.indexOf("--- 文書全体 ---")).toBeLessThan(text.indexOf("--- 選択範囲 ---"));
  });

  it("says where the body was cut so the model does not treat it as the end", () => {
    const text = userMessageWithAttachment("点検して", attachment({ truncated: true }));
    expect(text).toContain("この先は長いので添付していません");
  });

  it("ignores a selection of only whitespace", () => {
    const text = userMessageWithAttachment("点検して", attachment({ focus: " \n" }));
    expect(text).not.toContain("--- 選択範囲 ---");
  });
});

describe("attached files", () => {
  const scan: CommittedFile = {
    id: "f1",
    name: "覚書.pdf",
    origin: "ocr",
    body: "第1条 本覚書は…",
    comments: emptyMarkup<CommentNote>(),
    changes: emptyMarkup<ChangeNote>(),
    truncated: false,
    size: 2048,
    mtime: 1,
  };
  const contract: CommittedFile = {
    ...scan,
    id: "f2",
    name: "契約.docx",
    origin: "text",
    body: "第1条（目的）",
    comments: comments([comment()]),
  };

  it("sends the text behind one marker, naming each file in the body", () => {
    const text = userMessageWithAttachment("両方を見比べて", EMPTY_ATTACHMENT, [scan, contract]);
    expect(text.match(/--- 添付ファイル ---/g)).toHaveLength(1);
    expect(text).toContain("[1] 覚書.pdf（OCR 読み取り）");
    expect(text).toContain("[2] 契約.docx（テキスト読み取り）");
    expect(text).toContain("第1条 本覚書は…");
    expect(text).toContain("分割払いにしたい。");
  });

  it("puts the material behind the document and before the selection", () => {
    const text = userMessageWithAttachment("点検して", attachment({ focus: "第2条（報酬）" }), [
      scan,
    ]);
    expect(text.indexOf("--- 文書全体 ---")).toBeLessThan(text.indexOf("--- 添付ファイル ---"));
    expect(text.indexOf("--- 添付ファイル ---")).toBeLessThan(text.indexOf("--- 選択範囲 ---"));
  });

  it("leaves out a comment section for a file that cannot carry one", () => {
    const text = userMessageWithAttachment("読んで", EMPTY_ATTACHMENT, [scan]);
    expect(text).not.toContain("コメント:");
  });

  it("records only the names and sizes in the transcript", () => {
    const text = userMessageForHistory("読んで", EMPTY_ATTACHMENT, [scan, contract]);
    expect(text).toContain("[1] 覚書.pdf");
    expect(text).toContain("この会話に保存してあり");
    expect(text).not.toContain("第1条 本覚書は…");
    expect(text).not.toContain("分割払いにしたい。");
  });

  it("drops the stub on replay, as it does the rest of the attachment", () => {
    const stored = userMessageForHistory("読んで", EMPTY_ATTACHMENT, [scan]);
    expect(stripAttachment(stored)).toBe("読んで");
    expect(splitUserMessage(stored).files).toContain("覚書.pdf");
  });

  it("writes nothing at all on a turn with no files", () => {
    expect(userMessageWithAttachment("骨子を作って", EMPTY_ATTACHMENT, [])).toBe("骨子を作って");
    expect(userMessageForHistory("骨子を作って", EMPTY_ATTACHMENT, [])).toBe("骨子を作って");
  });
});

describe("userMessageForHistory", () => {
  it("records the size instead of the body, which is read again next turn", () => {
    const text = userMessageForHistory("点検して", attachment({ focus: "第2条（報酬）" }));
    expect(text).toContain("2 段落");
    expect(text).not.toContain("第1条（目的）");
    // The selection is short and records what the user was pointing at.
    expect(text).toContain("第2条（報酬）");
  });
});

describe("splitUserMessage", () => {
  it("separates the instruction, the body and the selection", () => {
    const parts = splitUserMessage(
      userMessageWithAttachment("点検して", attachment({ focus: "第2条（報酬）" }))
    );
    expect(parts.instruction).toBe("点検して");
    expect(parts.document).toContain("第1条（目的）");
    expect(parts.selection).toBe("第2条（報酬）");
  });

  it("separates the comments and the tracked changes as well", () => {
    const parts = splitUserMessage(
      userMessageWithAttachment(
        "相手の赤字を教えて",
        attachment({ markup: true, comments: comments([comment()]), changes: changes([change()]) })
      )
    );
    expect(parts.instruction).toBe("相手の赤字を教えて");
    expect(parts.document).toContain("第1条（目的）");
    expect(parts.comments).toContain("分割払いにしたい。");
    expect(parts.changes).toContain("無催告で");
  });

  it("still reads conversations saved with only a selection", () => {
    const parts = splitUserMessage("整えて\n\n--- 選択範囲 ---\n甲は乙に委託する。");
    expect(parts.instruction).toBe("整えて");
    expect(parts.document).toBe("");
    expect(parts.selection).toBe("甲は乙に委託する。");
  });

  it("leaves a message without markers alone", () => {
    expect(splitUserMessage("骨子を作って")).toEqual({
      instruction: "骨子を作って",
      document: "",
      comments: "",
      changes: "",
      files: "",
      selection: "",
    });
  });
});

function comment(partial: Partial<CommentNote> = {}): CommentNote {
  return {
    author: "田中太郎",
    date: "2026-09-10",
    resolved: false,
    anchor: "[段落 2]",
    content: "分割払いにしたい。",
    replies: [],
    ...partial,
  };
}

function change(partial: Partial<ChangeNote> = {}): ChangeNote {
  return {
    kind: "delete",
    author: "田中太郎",
    date: "2026-09-10",
    text: "無催告で",
    where: "[段落 12]",
    ...partial,
  };
}

function comments(items: CommentNote[], rest: Partial<MarkupList<CommentNote>> = {}) {
  return { items, truncated: false, error: "", ...rest };
}

function changes(items: ChangeNote[], rest: Partial<MarkupList<ChangeNote>> = {}) {
  return { items, truncated: false, error: "", ...rest };
}

describe("markup sections", () => {
  const render = (partial: Partial<Attachment>) =>
    userMessageWithAttachment("読んで", attachment({ markup: true, ...partial }));

  it("names the author, the anchor and the replies of each comment", () => {
    const text = render({
      comments: comments([
        comment({
          replies: [{ author: "佐藤花子", date: "2026-09-11", content: "検討します。" }],
        }),
      ]),
    });
    expect(text).toContain("--- コメント ---");
    expect(text).toContain("[1] 田中太郎 2026-09-10 [段落 2]");
    expect(text).toContain("分割払いにしたい。");
    expect(text).toContain("↳ 佐藤花子 2026-09-11 検討します。");
  });

  it("marks a resolved thread so the model does not raise it again", () => {
    expect(render({ comments: comments([comment({ resolved: true })]) })).toContain("解決済み");
  });

  it("says what kind of change it is and where it sits", () => {
    const text = render({ changes: changes([change()]) });
    expect(text).toContain("--- 変更履歴 ---");
    expect(text).toContain("[1] 削除 田中太郎 2026-09-10「無催告で」 [段落 12]");
  });

  it("labels every kind in Japanese", () => {
    const kinds: ChangeNote["kind"][] = ["insert", "delete", "format", "other"];
    const text = render({ changes: changes(kinds.map((kind) => change({ kind }))) });
    for (const label of ["挿入", "削除", "書式", "その他"]) {
      expect(text).toContain(label);
    }
  });

  it("says there are none, which is not the same as failing to read them", () => {
    const text = render({ comments: comments([]), changes: changes([]) });
    expect(text).toContain("コメントはありません。");
    expect(text).toContain("変更履歴はありません。");
  });

  it("points to inline comments when the appendix list is empty", () => {
    const text = render({
      inlineMarkup: true,
      inlineCommentCount: 4,
      comments: comments([]),
    });
    expect(text).toContain("--- コメント ---");
    expect(text).toContain("本文中に 4 件インライン（〔注…〕）");
    expect(text).not.toContain("コメントはありません");
  });

  it("says a failed read is not proof that there are none", () => {
    const text = render({ changes: changes([], { error: "GeneralException" }) });
    expect(text).toContain("変更履歴を読めませんでした（GeneralException）");
    expect(text).toContain("無いとは限りません");
  });

  it("says when the lists were cut short", () => {
    const text = render({ comments: comments([comment()], { truncated: true }) });
    expect(text).toContain("コメントが多いので途中まで");
  });

  it("does not claim there are none when there was no room to look", () => {
    const text = render({ comments: comments([], { truncated: true }) });
    expect(text).toContain("余白が足りず渡していません");
    expect(text).not.toContain("コメントはありません");
  });

  it("leaves both sections out when the user did not ask for them", () => {
    const text = userMessageWithAttachment(
      "読んで",
      attachment({ markup: false, comments: comments([comment()]) })
    );
    expect(text).not.toContain("--- コメント ---");
  });

  it("records in history that a turn carried no body, so the record can be checked", () => {
    const stored = userMessageForHistory(
      "点検して",
      attachment({ document: "", paragraphs: 0, truncated: true })
    );
    expect(stored).toContain("本文なし（添付の余白が足りず渡せませんでした）");
  });

  it("keeps the markup in history, since it records what the counterparty asked", () => {
    const stored = userMessageForHistory(
      "読んで",
      attachment({ markup: true, comments: comments([comment()]), changes: changes([change()]) })
    );
    expect(stored).toContain("分割払いにしたい。");
    expect(stored).toContain("無催告で");
    // The body is still only summarised.
    expect(stored).not.toContain("第1条（目的）");
  });

  it("drops the markup on replay, along with the rest of the attachment", () => {
    const sent = userMessageWithAttachment(
      "読んで",
      attachment({ markup: true, comments: comments([comment()]), changes: changes([change()]) })
    );
    expect(stripAttachment(sent)).toBe("読んで");
  });
});

describe("stripAttachment", () => {
  it("keeps the instruction only", () => {
    expect(stripAttachment(userMessageWithAttachment("点検して", attachment()))).toBe("点検して");
  });
});
