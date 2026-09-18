// One-off: per-turn request sizes. Prints counts only, never document text.
import path from "node:path";
import Database from "better-sqlite3";

const file = path.join(process.env.APPDATA, "GURI", "history.db");
const db = new Database(file, { readonly: true });

const conversations = db
  .prepare("SELECT id, title FROM conversations ORDER BY updated_at DESC LIMIT 2")
  .all();

for (const conversation of conversations) {
  console.log(`\n=== ${conversation.id}`);
  const rows = db
    .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid")
    .all(conversation.id);

  for (const row of rows) {
    let usage = "";
    if (row.usage_json) {
      try {
        const parsed = JSON.parse(row.usage_json);
        usage = Object.entries(parsed)
          .map(([key, value]) => `${key}=${value}`)
          .join(" ");
      } catch {
        usage = "(unparsable)";
      }
    }
    const calls = row.tool_calls_json
      ? JSON.parse(row.tool_calls_json)
          .map((call) => call.function?.name)
          .join(",")
      : "";
    console.log(
      [
        row.created_at.slice(11, 19),
        row.role.padEnd(9),
        `${String((row.content || "").length).padStart(6)}字`,
        `思考${String((row.reasoning_content || "").length).padStart(6)}字`,
        calls ? `tools:${calls}` : "",
        usage,
      ].join("  ")
    );
  }
}
