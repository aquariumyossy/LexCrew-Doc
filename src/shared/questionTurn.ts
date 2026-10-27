/** Shown in the chat before a question turn is allowed to edit the document. */
export const EDIT_CONFIRM_PROMPT = "質問への回答として文書を変えようとしています";
export const EDIT_CONFIRM_ALLOW = "変更してよい";
export const EDIT_CONFIRM_DECLINE = "変更せずに答えて";

/** Returned as the tool result when the user refuses the edit. */
export const EDIT_DECLINED_TOOL_RESULT =
  "利用者は文書の変更を断りました。ツールは実行していません。文書は変えず、チャットの文章だけで答えてください。";

const CHAT_ONLY = "チャットで答えて";
const NEGATIONS = ["修正しないで", "変更しないで"] as const;

/**
 * Imperative edit requests. A trailing 「ない」「た」 is a statement about an
 * edit (「直してない」), not a request to make one.
 */
const EDIT_VERBS = [
  "書き換えて",
  "置き換えて",
  "挿入して",
  "追加して",
  "追記して",
  "削除して",
  "修正して",
  "コメントして",
  "短くして",
  "整えて",
  "直して",
  "変えて",
  "入れて",
  "書いて",
  "削って",
  "消して",
  "足して",
  "作って",
  "加えて",
  "揃えて",
  "戻して",
  "記載して",
  "訂正して",
] as const;

/** 「もらえますか？」 and the like are edit requests even when they end in ？. */
const REQUEST_FORM = /もらえますか|もらえる|くれますか|くれる|ください/;

const EXPLAIN_SIGNALS = [
  "教えて",
  "説明して",
  "ですか",
  "なんで",
  "なぜ",
  "何故",
  "どうして",
  "どういう",
] as const;

function editVerbAt(text: string, index: number, verb: string): boolean {
  const after = text.slice(index + verb.length);
  return !/^(?:ない|ません|た)/.test(after);
}

function hasEditVerb(text: string): boolean {
  return EDIT_VERBS.some((verb) => {
    let from = 0;
    while (from < text.length) {
      const at = text.indexOf(verb, from);
      if (at < 0) {
        return false;
      }
      if (editVerbAt(text, at, verb)) {
        return true;
      }
      from = at + verb.length;
    }
    return false;
  });
}

/** 「〜しないで」 is a question only when the user does not go on to ask for an edit. */
function negationAsksToLeaveTheDocument(text: string): boolean {
  return NEGATIONS.some((phrase) => {
    let from = 0;
    while (from < text.length) {
      const at = text.indexOf(phrase, from);
      if (at < 0) {
        return false;
      }
      if (!hasEditVerb(text.slice(at + phrase.length))) {
        return true;
      }
      from = at + phrase.length;
    }
    return false;
  });
}

/**
 * Question-like instructions. False negatives are preferred: an ordinary edit
 * such as 「見出しを直して」 must not be held for confirmation.
 * Only the user's instruction is checked, never the attached document.
 */
export function isQuestionInstruction(instruction: string): boolean {
  const text = (instruction || "").trim();
  if (!text) {
    return false;
  }
  if (text.includes(CHAT_ONLY) || negationAsksToLeaveTheDocument(text)) {
    return true;
  }
  // 「理由」 on its own is an edit topic (「解除理由を追記して」). These two
  // shapes are the question.
  if (text.includes("理由は") || text.includes("理由を教えて")) {
    return true;
  }
  const editing = hasEditVerb(text);
  if (!editing && EXPLAIN_SIGNALS.some((signal) => text.includes(signal))) {
    return true;
  }
  // 「〜の？」 anywhere, or a question mark at the end. A request form
  // (「してもらえますか？」「してくれる？」) is still an edit.
  if (REQUEST_FORM.test(text)) {
    return false;
  }
  if (/の[？?]/.test(text)) {
    return true;
  }
  if (/[？?]\s*$/.test(text)) {
    return true;
  }
  return false;
}
