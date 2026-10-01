import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  adoptConnection,
  connectionPath,
  parseConnectionText,
  readConnection,
  resolveConnection,
  saveConnection,
  sweepConnectionTemps,
} from "./connection";

const dirs: string[] = [];
const secret = "super-secret-key";

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function root(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lexcrew-conn-"));
  dirs.push(dir);
  return dir;
}

function fileIn(dir: string): string {
  return path.join(dir, "connection.json");
}

describe("connectionPath", () => {
  it("reads LexCrew/connection.json under APPDATA", () => {
    expect(connectionPath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" } as NodeJS.ProcessEnv, "win32")).toBe(
      path.join("C:\\Users\\me\\AppData\\Roaming", "LexCrew", "connection.json")
    );
  });
});

describe("readConnection", () => {
  it("fills a missing key with an empty string and ignores anything else", () => {
    const dir = root();
    const file = fileIn(dir);
    fs.writeFileSync(file, JSON.stringify({ llmBaseUrl: "http://llm", extra: secret, llmApiKey: 12 }));
    expect(readConnection(file)).toEqual({
      kind: "ready",
      connection: { llmBaseUrl: "http://llm", llmApiKey: "", searxngUrl: "" },
    });
  });

  it("treats an empty object as ready and empty", () => {
    const file = fileIn(root());
    fs.writeFileSync(file, "{}");
    expect(readConnection(file)).toEqual({
      kind: "ready",
      connection: { llmBaseUrl: "", llmApiKey: "", searxngUrl: "" },
    });
  });

  it("accepts a leading BOM and still reads the object", () => {
    const file = fileIn(root());
    fs.writeFileSync(file, `\uFEFF${JSON.stringify({ searxngUrl: "http://searx" })}`, "utf8");
    expect(readConnection(file).kind).toBe("ready");
    if (readConnection(file).kind === "ready") {
      expect(readConnection(file)).toMatchObject({ connection: { llmBaseUrl: "", searxngUrl: "http://searx" } });
    }
  });

  it("reports a broken file without the key that was inside it", () => {
    const file = fileIn(root());
    fs.writeFileSync(file, `{"llmApiKey":"${secret}"`);
    const lines: string[] = [];
    expect(readConnection(file, (line) => lines.push(line))).toEqual({ kind: "broken" });
    expect(lines.join("\n")).not.toContain(secret);
    expect(parseConnectionText("[]").kind).toBe("broken");
    expect(parseConnectionText("").kind).toBe("broken");
    expect(parseConnectionText("null").kind).toBe("broken");
    expect(parseConnectionText("12").kind).toBe("broken");
    expect(parseConnectionText('"text"').kind).toBe("broken");
  });

  it("reports a directory as broken and does not throw", () => {
    const dir = root();
    const file = fileIn(dir);
    fs.mkdirSync(file);
    expect(readConnection(file)).toEqual({ kind: "broken" });
  });

  it("reports a missing file as absent", () => {
    expect(readConnection(fileIn(root()))).toEqual({ kind: "absent" });
  });
});

describe("adoptConnection", () => {
  it("does not create a file when every value is empty", () => {
    const file = fileIn(root());
    expect(adoptConnection(file, { llmBaseUrl: "", llmApiKey: "", searxngUrl: "" })).toEqual({ kind: "absent" });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("does not replace a file that is already there, even when the incoming values differ", () => {
    const file = fileIn(root());
    fs.writeFileSync(file, JSON.stringify({ llmBaseUrl: "http://doc", llmApiKey: "doc-key", searxngUrl: "http://searx" }));
    const before = fs.readFileSync(file);
    const result = adoptConnection(file, { llmBaseUrl: "http://mail", llmApiKey: secret, searxngUrl: "" });
    expect(result).toEqual({
      kind: "ready",
      connection: { llmBaseUrl: "http://doc", llmApiKey: "doc-key", searxngUrl: "http://searx" },
    });
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("does not refill an empty object from incoming values", () => {
    const file = fileIn(root());
    fs.writeFileSync(file, "{}");
    const result = adoptConnection(file, { llmBaseUrl: "http://mail", llmApiKey: secret, searxngUrl: "http://searx" });
    expect(result).toEqual({ kind: "ready", connection: { llmBaseUrl: "", llmApiKey: "", searxngUrl: "" } });
    expect(fs.readFileSync(file, "utf8")).toBe("{}");
  });

  it("does not replace a broken file on startup", () => {
    const file = fileIn(root());
    fs.writeFileSync(file, "{");
    const before = fs.readFileSync(file);
    expect(adoptConnection(file, { llmBaseUrl: "http://llm", llmApiKey: secret, searxngUrl: "" })).toEqual({
      kind: "broken",
    });
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("publishes a complete file only when the name is free", () => {
    const file = fileIn(root());
    const incoming = { llmBaseUrl: "http://llm", llmApiKey: secret, searxngUrl: "http://searx" };
    expect(adoptConnection(file, incoming)).toEqual({ kind: "ready", connection: incoming });
    const first = fs.readFileSync(file);
    expect(first[0]).not.toBe(0xef);
    expect(first.toString("utf8").charCodeAt(0)).not.toBe(0xfeff);
    expect(Object.keys(JSON.parse(first.toString("utf8")) as object)).toEqual(["llmBaseUrl", "llmApiKey", "searxngUrl"]);
    adoptConnection(file, { llmBaseUrl: "http://other", llmApiKey: "other", searxngUrl: "" });
    expect(fs.readFileSync(file)).toEqual(first);
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("saveConnection", () => {
  it("replaces the file with the three keys and no BOM", () => {
    const file = fileIn(root());
    fs.writeFileSync(file, JSON.stringify({ llmBaseUrl: "old", extra: secret }));
    saveConnection(file, { llmBaseUrl: "http://llm", llmApiKey: secret, searxngUrl: "" });
    const bytes = fs.readFileSync(file);
    expect(bytes[0]).not.toBe(0xef);
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, string>;
    expect(Object.keys(parsed)).toEqual(["llmBaseUrl", "llmApiKey", "searxngUrl"]);
    expect(parsed).toEqual({ llmBaseUrl: "http://llm", llmApiKey: secret, searxngUrl: "" });
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not create a file when every value is empty and the name is free", () => {
    const file = fileIn(root());
    saveConnection(file, { llmBaseUrl: "", llmApiKey: "", searxngUrl: "" });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("replaces an existing file with empty strings", () => {
    const file = fileIn(root());
    fs.writeFileSync(file, JSON.stringify({ llmBaseUrl: "http://llm", llmApiKey: secret, searxngUrl: "http://searx" }));
    saveConnection(file, { llmBaseUrl: "", llmApiKey: "", searxngUrl: "" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      llmBaseUrl: "",
      llmApiKey: "",
      searxngUrl: "",
    });
  });

  it("replaces a broken file when the user saves", () => {
    const file = fileIn(root());
    fs.writeFileSync(file, "{");
    saveConnection(file, { llmBaseUrl: "http://llm", llmApiKey: secret, searxngUrl: "" });
    expect(readConnection(file)).toEqual({
      kind: "ready",
      connection: { llmBaseUrl: "http://llm", llmApiKey: secret, searxngUrl: "" },
    });
  });
});

describe("sweepConnectionTemps", () => {
  it("removes a stale temp without writing its contents to the log", () => {
    const dir = root();
    const stale = path.join(dir, "connection.json.old.dead.tmp");
    const fresh = path.join(dir, "connection.json.now.live.tmp");
    fs.writeFileSync(stale, secret);
    fs.writeFileSync(fresh, secret);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(stale, old, old);
    const lines: string[] = [];
    sweepConnectionTemps(dir);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(lines.join("\n")).not.toContain(secret);
  });
});

describe("resolveConnection", () => {
  it("prefers a ready file over the request body", () => {
    const file = {
      kind: "ready" as const,
      connection: { llmBaseUrl: "http://file", llmApiKey: "file-key", searxngUrl: "http://file-searx" },
    };
    expect(resolveConnection(file, { llmBaseUrl: "http://body", llmApiKey: "body-key", searxngUrl: "http://body-searx" })).toEqual(
      file.connection
    );
  });

  it("uses the request body when the file is missing or broken", () => {
    const body = { llmBaseUrl: "http://body", llmApiKey: "body-key", searxngUrl: "" };
    expect(resolveConnection({ kind: "absent" }, body)).toEqual(body);
    expect(resolveConnection({ kind: "broken" }, body)).toEqual(body);
  });
});
