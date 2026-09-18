// One-off: for each recent user turn, show which attachment sections were stored
// and how big they were. Prints structure and sizes only, never document text.
import path from "node:path";
import Database from "better-sqlite3";

const file = path.join(process.env.APPDATA, "GURI", "history.db");
const db = new Database(file, { readonly: true });

const MARKERS = [
  ["文書全体", "--- 文書全体 ---"],
  ["コメント", "--- コメント ---"],
  ["変更履歴", "--- 変更履歴 ---"],
  ["添付ファイル", "--- 添付ファイル ---"],
  ["選択範囲", "--- 選択範囲 ---"],
];

const conversations = db
  .prepare("SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 4")
  .all();

for (const conversation of conversations) {
  console.log(`\n=== ${conversation.updated_at}  ${conversation.title}`);
  const rows = db
    .prepare(
      "SELECT role, content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at, rowid"
    )
    .all(conversation.id);

  rows.forEach((row, index) => {
    const content = row.content || "";
    const found = MARKERS.map(([name, marker]) => {
      const at = content.indexOf(`\n\n${marker}\n`);
      return { name, marker, at };
    })
      .filter((hit) => hit.at >= 0)
      .sort((a, b) => a.at - b.at);

    const instruction = found.length ? content.slice(0, found[0].at) : content;
    const parts = found.map((hit, order) => {
      const from = hit.at + hit.marker.length + 3;
      const to = order + 1 < found.length ? found[order + 1].at : content.length;
      const body = content.slice(from, to);
      // The document section is a stored summary line, so it is safe to show.
      const detail = hit.name === "文書全体" ? ` "${body.trim()}"` : ` ${body.length}字`;
      return `${hit.name}${detail}`;
    });

    console.log(
      `  [${index + 1}] 指示${instruction.length}字 | ${parts.length ? parts.join(" | ") : "添付なし"}`
    );
    console.log(`      指示先頭: ${instruction.slice(0, 40).replace(/\s+/g, " ")}`);
  });
}
