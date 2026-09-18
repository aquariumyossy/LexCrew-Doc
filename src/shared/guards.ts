/**
 * Chat turns always carry an instruction. The attachment is optional and is
 * trimmed to the budget rather than refused, so nothing is checked here.
 */
export function assertChatInput(instruction: string): void {
  if (!instruction.trim()) {
    throw new Error("指示を入力してください。");
  }
}
