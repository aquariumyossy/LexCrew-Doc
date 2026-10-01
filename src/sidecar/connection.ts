import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

export type Connection = {
  llmBaseUrl: string;
  llmApiKey: string;
  searxngUrl: string;
};

export type ConnectionFile =
  | { kind: "ready"; connection: Connection }
  | { kind: "absent" }
  | { kind: "broken" };

const STALE_TEMP_MS = 60_000;

/** Same root as `history.ts` `dataDir`, which mirrors `dirs::data_dir()`. */
export function dataRoot(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (platform === "win32") {
    return env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}

export function connectionPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  return path.join(dataRoot(env, platform), "LexCrew", "connection.json");
}

export function readConnection(file: string, log: (line: string) => void = () => {}): ConnectionFile {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    log("connection.json を読めません");
    return { kind: "broken" };
  }
  return parseConnectionText(text, log);
}

export function parseConnectionText(text: string, log: (line: string) => void = () => {}): ConnectionFile {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    const parsed = JSON.parse(source) as unknown;
    if (!isRecord(parsed)) {
      log("connection.json を読めません");
      return { kind: "broken" };
    }
    return { kind: "ready", connection: connectionFromRecord(parsed) };
  } catch {
    log("connection.json を読めません");
    return { kind: "broken" };
  }
}

export function resolveConnection(
  file: ConnectionFile,
  body: { llmBaseUrl?: unknown; llmApiKey?: unknown; searxngUrl?: unknown }
): Connection {
  if (file.kind === "ready") return file.connection;
  return {
    llmBaseUrl: String(body.llmBaseUrl ?? ""),
    llmApiKey: String(body.llmApiKey ?? ""),
    searxngUrl: String(body.searxngUrl ?? ""),
  };
}

export function connectionFromBody(body: unknown): Connection {
  const record = isRecord(body) ? body : {};
  return connectionFromRecord(record);
}

/** Startup must not replace a file LexCrew Mail already published. */
export function adoptConnection(file: string, incoming: Connection, log: (line: string) => void = () => {}): ConnectionFile {
  const current = readConnection(file, log);
  if (current.kind !== "absent") return current;
  if (isEmpty(incoming)) return current;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  sweepConnectionTemps(dir);
  const tmp = tempPath(dir);
  try {
    writeComplete(tmp, incoming);
    try {
      // A hard link fails when the name is taken, so a race does not replace the winner.
      fs.linkSync(tmp, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return readConnection(file, log);
      throw new Error("接続ファイルを作成できません。");
    }
    return readConnection(file, log);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The name was already removed, or the process is cleaning up after a failed write.
    }
  }
}

export function saveConnection(file: string, incoming: Connection): void {
  if (isEmpty(incoming) && readConnection(file).kind === "absent") return;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  sweepConnectionTemps(dir);
  const tmp = tempPath(dir);
  try {
    writeComplete(tmp, incoming);
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // rename already took the temp name.
    }
  }
}

export function sweepConnectionTemps(dir: string, now = Date.now()): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith("connection.json.") || !name.endsWith(".tmp")) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs < STALE_TEMP_MS) continue;
      fs.unlinkSync(full);
    } catch {
      // Another writer removed it first.
    }
  }
}

export function connectionPayload(
  file: ConnectionFile
): { kind: "ready"; llmBaseUrl: string; llmApiKey: string; searxngUrl: string } | { kind: "absent" } | { kind: "broken" } {
  if (file.kind !== "ready") return { kind: file.kind };
  return { kind: "ready", ...file.connection };
}

function writeComplete(tmp: string, incoming: Connection): void {
  const bytes = encode(incoming);
  const handle = fs.openSync(tmp, "w");
  try {
    fs.writeSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function encode(incoming: Connection): Buffer {
  const body = {
    llmBaseUrl: incoming.llmBaseUrl,
    llmApiKey: incoming.llmApiKey,
    searxngUrl: incoming.searxngUrl,
  };
  return Buffer.from(`${JSON.stringify(body, null, 2)}\n`, "utf8");
}

function tempPath(dir: string): string {
  return path.join(dir, `connection.json.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
}

function connectionFromRecord(record: Record<string, unknown>): Connection {
  return {
    llmBaseUrl: stringField(record.llmBaseUrl),
    llmApiKey: stringField(record.llmApiKey),
    searxngUrl: stringField(record.searxngUrl),
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isEmpty(incoming: Connection): boolean {
  return !incoming.llmBaseUrl && !incoming.llmApiKey && !incoming.searxngUrl;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
