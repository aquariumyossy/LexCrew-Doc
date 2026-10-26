/** Shown in the chat before a question turn is allowed to edit the document. */
export const EDIT_CONFIRM_PROMPT = "質問への回答として文書を変えようとしています";
export const EDIT_CONFIRM_ALLOW = "変更してよい";
export const EDIT_CONFIRM_DECLINE = "変更せずに答えて";

/** Returned as the tool result when the user refuses the edit. */
export const EDIT_DECLINED_TOOL_RESULT =
  "利用者は文書の変更を断りました。ツールは実行していません。文書は変えず、チャットの文章だけで答えてください。";

const EXPLICIT_CHAT_ONLY = ["修正しないで", "変更しないで", "チャットで答えて"] as const;

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
  if (EXPLICIT_CHAT_ONLY.some((phrase) => text.includes(phrase))) {
    return true;
  }
  if (
    text.includes("なぜ") ||
    text.includes("何故") ||
    text.includes("どうして") ||
    text.includes("理由")
  ) {
    return true;
  }
  // 「〜の？」 anywhere, or a question mark at the end.
  if (/の[？?]/.test(text)) {
    return true;
  }
  if (/[？?]\s*$/.test(text)) {
    return true;
  }
  return false;
}
