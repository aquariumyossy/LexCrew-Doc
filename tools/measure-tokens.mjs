// One-off: fit tokens-per-character from real usage. For each user turn we know
// what was sent (the stored summary tells us the body size), and the first
// assistant reply of that turn reports promptTokens. Prints counts only.
import path from "node:path";
import Database from "better-sqlite3";

const db = new Database(path.join(process.env.APPDATA, "GURI", "history.db"), { readonly: true });

const MARKERS = ["--- 文書全体 ---", "--- コメント ---", "--- 変更履歴 ---", "--- 添付ファイル ---", "--- 選択範囲 ---"];

function sections(content) {
  const found = MARKERS.map((marker) => ({ marker, at: content.indexOf(`\n\n${marker}\n`) }))
    .filter((hit) => hit.at >= 0)
    .sort((a, b) => a.at - b.at);
  const out = { instruction: found.length ? content.slice(0, found[0].at) : content };
  found.forEach((hit, index) => {
    const from = hit.at + hit.marker.length + 3;
    const to = index + 1 < found.length ? found[index + 1].at : content.length;
    out[hit.marker] = content.slice(from, to);
  });
  return out;
}

/** The stored body line reads "169 段落 12,311 字（…）". */
function bodyChars(summary) {
  const match = (summary || "").match(/([\d,]+)\s*字/);
  return match ? Number(match[1].replace(/,/g, "")) : 0;
}

const rows = [];
for (const conversation of db
  .prepare("SELECT id FROM conversations ORDER BY updated_at DESC LIMIT 4")
  .all()) {
  const messages = db
    .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid")
    .all(conversation.id);

  let history = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "user") {
      history += (message.content || "").length + (message.tool_calls_json || "").length;
      continue;
    }
    const parsed = sections(message.content || "");
    const summary = parsed["--- 文書全体 ---"];
    const sent =
      (message.content || "").length - (summary || "").length + bodyChars(summary);
    const reply = messages[index + 1];
    const usage = reply?.usage_json ? JSON.parse(reply.usage_json) : null;
    if (usage?.promptTokens) {
      rows.push({
        chars: sent + history,
        tokens: usage.promptTokens,
        files: Boolean(parsed["--- 添付ファイル ---"]),
      });
    }
    history += parsed.instruction.length;
  }
}

const clean = rows.filter((row) => !row.files);
console.log("turn samples (files excluded):");
for (const row of clean) {
  console.log(`  chars=${String(row.chars).padStart(7)}  promptTokens=${row.tokens}`);
}

// Least squares through tokens = a * chars + b.
const n = clean.length;
const sx = clean.reduce((t, r) => t + r.chars, 0);
const sy = clean.reduce((t, r) => t + r.tokens, 0);
const sxx = clean.reduce((t, r) => t + r.chars * r.chars, 0);
const sxy = clean.reduce((t, r) => t + r.chars * r.tokens, 0);
const a = (n * sxy - sx * sy) / (n * sxx - sx * sx);
const b = (sy - a * sx) / n;
console.log(`\ntokens per character: ${a.toFixed(3)}`);
console.log(`chars per token: ${(1 / a).toFixed(2)}`);
console.log(`fixed overhead (system + tools): ${Math.round(b)} tokens`);
