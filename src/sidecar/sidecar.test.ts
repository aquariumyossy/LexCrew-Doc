import fs from "fs";
import http from "http";
import { AddressInfo } from "net";
import os from "os";
import path from "path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { pickDefaultModel } from "./llm";

const absentConnection = path.join(os.tmpdir(), `guri-sidecar-absent-${process.pid}`, "connection.json");

type MockServer = {
  url: string;
  close: () => Promise<void>;
};

function listen(handler: http.RequestListener): Promise<MockServer> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

function readJsonBody(
  req: http.IncomingMessage,
  onBody: (body: Record<string, unknown>) => void
): void {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c as Buffer));
  req.on("end", () => {
    onBody(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
  });
}

const servers: MockServer[] = [];

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop();
    await s?.close();
  }
  vi.restoreAllMocks();
});

describe("pickDefaultModel", () => {
  it("matches qwen3.8-flash-next despite punctuation drift", () => {
    expect(pickDefaultModel(["qwen3_8-flash-next", "other"])).toBe("qwen3_8-flash-next");
  });
});

describe("sidecar", () => {
  it("GET /api/health reports the local process", async () => {
    const app = createApp({ connectionFile: absentConnection });
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, service: "LexCrew Doc" });
  });

  it("checks MTPLX via GET /v1/models then SearXNG JSON search", async () => {
    const mtplx = await listen((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "qwen3.8-flash-next" }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(mtplx);

    const searx = await listen((req, res) => {
      if (req.url?.startsWith("/search?")) {
        const url = new URL(req.url, mtplx.url);
        expect(url.searchParams.get("format")).toBe("json");
        expect(url.searchParams.get("language")).toBe("ja");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            results: [{ title: "民法", url: "https://example.jp/m", content: "抜粋" }],
          })
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(searx);

    const app = createApp({ connectionFile: absentConnection });
    const res = await request(app)
      .post("/api/health")
      .send({
        llmBaseUrl: `${mtplx.url}/v1`,
        llmApiKey: "test-key",
        searxngUrl: searx.url,
      });
    expect(res.status).toBe(200);
    expect(res.body.llm.ok).toBe(true);
    expect(res.body.llm.models).toContain("qwen3.8-flash-next");
    expect(res.body.searxng.ok).toBe(true);
  });

  it("falls back to GET /health when /v1/models is down", async () => {
    const mtplx = await listen((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(500);
      res.end("no models");
    });
    servers.push(mtplx);

    const app = createApp({ connectionFile: absentConnection });
    const res = await request(app).post("/api/health").send({
      llmBaseUrl: mtplx.url,
      llmApiKey: "test-key",
    });
    expect(res.status).toBe(200);
    expect(res.body.llm.ok).toBe(true);
  });

  it("forwards tools and thinking, then returns tool calls and usage", async () => {
    let seen: Record<string, unknown> | null = null;
    const mtplx = await listen((req, res) => {
      readJsonBody(req, (body) => {
        seen = body;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: "",
                  reasoning_content: "どの条文か確かめる",
                  tool_calls: [
                    {
                      id: "c1",
                      type: "function",
                      function: { name: "search", arguments: '{"q":"民法"}' },
                    },
                  ],
                },
              },
            ],
            usage: {
              prompt_tokens: 400,
              completion_tokens: 60,
              total_tokens: 460,
              completion_tokens_details: { reasoning_tokens: 30 },
            },
          })
        );
      });
    });
    servers.push(mtplx);

    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const app = createApp({ connectionFile: absentConnection });
    const res = await request(app)
      .post("/api/chat")
      .send({
        llmBaseUrl: `${mtplx.url}/v1`,
        llmApiKey: "test-key",
        model: "qwen3.8-flash-next",
        messages: [{ role: "user", content: "SECRET_PROMPT 本文そのもの" }],
        tools: [{ type: "function", function: { name: "search", parameters: { type: "object" } } }],
        thinkingLevel: "medium",
      });

    expect(res.status).toBe(200);
    expect(seen).toMatchObject({
      tool_choice: "auto",
      reasoning_effort: "medium",
      chat_template_kwargs: { enable_thinking: true },
    });
    expect(seen).not.toHaveProperty("thinking_budget");
    expect((seen as { chat_template_kwargs: object }).chat_template_kwargs).not.toHaveProperty(
      "thinking_budget"
    );
    expect(res.body.finishReason).toBe("tool_calls");
    expect(res.body.toolCalls[0].function.name).toBe("search");
    expect(res.body.reasoningContent).toBe("どの条文か確かめる");
    expect(res.body.usage).toEqual({
      promptTokens: 400,
      completionTokens: 60,
      totalTokens: 460,
      reasoningTokens: 30,
    });

    const dumped = [...info.mock.calls, ...error.mock.calls]
      .map((c) => JSON.stringify(c))
      .join("\n");
    expect(dumped).not.toContain("SECRET_PROMPT");
    expect(dumped).not.toContain("本文そのもの");
    expect(dumped).not.toContain("どの条文か確かめる");
  });

  it("retries without the thinking fields after 400 and strips think tags", async () => {
    let sawThinking = false;
    let sawRetry = false;
    const mtplx = await listen((req, res) => {
      readJsonBody(req, (body) => {
        if (body.chat_template_kwargs) {
          sawThinking = true;
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "unknown field" } }));
          return;
        }
        sawRetry = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "<think>hidden</think>コメントを付けました。" },
              },
            ],
          })
        );
      });
    });
    servers.push(mtplx);

    const app = createApp({ connectionFile: absentConnection });
    const res = await request(app)
      .post("/api/chat")
      .send({
        llmBaseUrl: `${mtplx.url}/v1`,
        llmApiKey: "test-key",
        messages: [{ role: "user", content: "点検して" }],
        thinkingLevel: "medium",
      });

    expect(res.status).toBe(200);
    expect(sawThinking).toBe(true);
    expect(sawRetry).toBe(true);
    expect(res.body.content).toBe("コメントを付けました。");
    expect(res.body.toolCalls).toEqual([]);
  });

  it("wraps a JSON chat reply as SSE when stream is requested", async () => {
    let seen: Record<string, unknown> | null = null;
    const mtplx = await listen((req, res) => {
      readJsonBody(req, (body) => {
        seen = body;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "コメントを付けました。" },
              },
            ],
          })
        );
      });
    });
    servers.push(mtplx);

    const app = createApp({ connectionFile: absentConnection });
    const res = await request(app)
      .post("/api/chat")
      .send({
        llmBaseUrl: `${mtplx.url}/v1`,
        llmApiKey: "test-key",
        messages: [{ role: "user", content: "点検して" }],
        stream: true,
      });

    expect(res.status).toBe(200);
    expect(seen?.stream).toBe(true);
    expect(res.headers["content-type"]).toMatch(/event-stream/);
    expect(res.text).toContain("[DONE]");
    const line = res.text
      .split("\n")
      .find((row) => row.startsWith("data:") && !row.includes("[DONE]"));
    expect(line).toBeDefined();
    const payload = JSON.parse((line as string).replace(/^data:\s*/, "")) as {
      choices: { message: { content: string } }[];
    };
    expect(payload.choices[0].message.content).toBe("コメントを付けました。");
  });

  it("pipes MTPLX SSE bytes through when stream is requested", async () => {
    let seen: Record<string, unknown> | null = null;
    const mtplx = await listen((req, res) => {
      readJsonBody(req, (body) => {
        seen = body;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"こんにちは"}}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    servers.push(mtplx);

    const app = createApp({ connectionFile: absentConnection });
    const res = await request(app)
      .post("/api/chat")
      .send({
        llmBaseUrl: `${mtplx.url}/v1`,
        llmApiKey: "test-key",
        messages: [{ role: "user", content: "こんにちは" }],
        stream: true,
      });

    expect(res.status).toBe(200);
    expect(seen?.stream).toBe(true);
    expect(res.headers["content-type"]).toMatch(/event-stream/);
    expect(res.text).toContain("こんにちは");
    expect(res.text).toContain("[DONE]");
  });

  it("searches SearXNG and maps hits", async () => {
    const searx = await listen((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      expect(url.pathname).toBe("/search");
      expect(url.searchParams.get("q")).toBe("民法");
      expect(url.searchParams.get("format")).toBe("json");
      expect(url.searchParams.get("language")).toBe("ja");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          results: [{ title: "e-Gov 民法", url: "https://laws.e-gov.go.jp/", content: "第415条" }],
        })
      );
    });
    servers.push(searx);

    const app = createApp({ connectionFile: absentConnection });
    const res = await request(app).post("/api/search").send({
      searxngUrl: searx.url,
      q: "民法",
    });
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("searxng");
    expect(res.body.results[0].title).toBe("e-Gov 民法");
  });

  it("explains SearXNG 403 JSON-disabled instances", async () => {
    const searx = await listen((_req, res) => {
      res.writeHead(403);
      res.end("forbidden");
    });
    servers.push(searx);

    const app = createApp({ connectionFile: absentConnection });
    const res = await request(app).post("/api/search").send({
      searxngUrl: searx.url,
      q: "テスト",
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/json/i);
  });

  it("checks Argos health, lists scopes, and maps search hits", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const mtplx = await listen((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "qwen3.8-flash-next" }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(mtplx);

    const argos = await listen((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        expect(req.headers.authorization).toBeUndefined();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, name: "argos" }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/scopes")) {
        const url = new URL(req.url, "http://127.0.0.1");
        expect(url.searchParams.get("query")).toBe("受信");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            recent: [{ path: "C:\\案件A", label: "案件A", isRoot: false }],
            scopes: [
              {
                path: "mailfolder:user@firm / 受信トレイ",
                label: "受信トレイ（user@firm）",
                isRoot: true,
              },
            ],
          })
        );
        return;
      }
      if (req.method === "POST" && req.url === "/search") {
        readJsonBody(req, (body) => {
          expect(body.query).toBe("民法 555条");
          expect(body.limit).toBe(8);
          expect(body.pathPrefixes).toEqual(["C:\\案件A"]);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              hits: [
                {
                  title: "契約.md",
                  path: "C:\\案件A\\契約.md",
                  snippet: "民法第555条",
                },
              ],
            })
          );
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(argos);

    const app = createApp({ connectionFile: absentConnection });
    const health = await request(app)
      .post("/api/health")
      .send({
        llmBaseUrl: `${mtplx.url}/v1`,
        llmApiKey: "test-key",
        argosBaseUrl: argos.url.replace("127.0.0.1", "localhost"),
      });
    expect(health.status).toBe(200);
    expect(health.body.argos.ok).toBe(true);

    const scopes = await request(app).post("/api/argos/scopes").send({
      argosBaseUrl: argos.url,
      query: "受信",
    });
    expect(scopes.status).toBe(200);
    expect(scopes.body.recent[0].path).toBe("C:\\案件A");
    expect(scopes.body.scopes[0].isRoot).toBe(true);

    const search = await request(app)
      .post("/api/argos/search")
      .send({
        argosBaseUrl: argos.url,
        q: "民法 555条",
        pathPrefixes: ["C:\\案件A"],
      });
    expect(search.status).toBe(200);
    expect(search.body.provider).toBe("argos");
    expect(search.body.results[0]).toEqual({
      title: "契約.md",
      url: "C:\\案件A\\契約.md",
      content: "民法第555条",
    });

    const dumped = info.mock.calls.map((c) => JSON.stringify(c)).join("\n");
    expect(dumped).not.toContain("民法 555条");
    expect(dumped).not.toContain("民法第555条");
  });
});

describe("POST /api/argos/file", () => {
  it("returns the bytes of a path the search returned, and refuses any other path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guri-indexed-"));
    const filePath = path.join(dir, "委託.txt");
    fs.writeFileSync(filePath, "みなし合格とする。", "utf8");
    const { clearIndexedPaths } = await import("./indexedPaths");
    clearIndexedPaths();
    const argos = await listen((req, res) => {
      if (req.method === "POST" && req.url === "/search") {
        readJsonBody(req, () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              hits: [{ title: "委託.txt", path: filePath, snippet: "みなし" }],
            })
          );
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const app = createApp({ connectionFile: absentConnection });
      const before = await request(app).post("/api/argos/file").send({ path: filePath });
      expect(before.status).toBe(403);

      const search = await request(app)
        .post("/api/argos/search")
        .send({ argosBaseUrl: argos.url, q: "みなし合格" });
      expect(search.status).toBe(200);
      expect(search.body.results[0].url).toBe(filePath);

      const read = await request(app).post("/api/argos/file").send({ path: filePath });
      expect(read.status).toBe(200);
      expect(Buffer.from(read.body.data, "base64").toString("utf8")).toBe("みなし合格とする。");

      const other = await request(app)
        .post("/api/argos/file")
        .send({ path: path.join(dir, "..", "秘密.txt") });
      expect(other.status).toBe(403);
    } finally {
      await argos.close();
      fs.rmSync(dir, { recursive: true, force: true });
      clearIndexedPaths();
    }
  });
});

const PAGE_IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

describe("POST /api/ocr", () => {
  it("sends the page as a vision message and returns the text it read", async () => {
    let sent: Record<string, unknown> = {};
    const mtplx = await listen((req, res) => {
      readJsonBody(req, (body) => {
        sent = body;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "第1条（目的）" } }] }));
      });
    });
    servers.push(mtplx);

    const app = createApp({ connectionFile: absentConnection });
    const res = await request(app)
      .post("/api/ocr")
      .send({
        llmBaseUrl: `${mtplx.url}/v1`,
        llmApiKey: "test-key",
        model: "qwen-vl",
        image: PAGE_IMAGE,
      });

    expect(res.status).toBe(200);
    expect(res.body.text).toBe("第1条（目的）");
    const parts = (sent.messages as { content: { type: string }[] }[])[0].content;
    expect(parts.map((part) => part.type)).toEqual(["text", "image_url"]);
    // Transcription is not a reasoning task, and thinking per page is slow.
    expect(sent.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("takes a page larger than the limit that guards every other body", async () => {
    const mtplx = await listen((req, res) => {
      readJsonBody(req, () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "読めました" } }] }));
      });
    });
    servers.push(mtplx);

    // Over the 2MB global limit, under the OCR route's own.
    const big = `data:image/jpeg;base64,${"A".repeat(4 * 1024 * 1024)}`;
    const res = await request(createApp({ connectionFile: absentConnection }))
      .post("/api/ocr")
      .send({ llmBaseUrl: `${mtplx.url}/v1`, llmApiKey: "k", image: big });
    expect(res.status).toBe(200);

    const chat = await request(createApp({ connectionFile: absentConnection }))
      .post("/api/chat")
      .send({
        llmBaseUrl: `${mtplx.url}/v1`,
        llmApiKey: "k",
        messages: [{ role: "user", content: big }],
      });
    expect(chat.status).toBeGreaterThanOrEqual(400);
  });

  it("says which setting to change when the model cannot see", async () => {
    const mtplx = await listen((req, res) => {
      readJsonBody(req, () => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "this model does not support image input" } }));
      });
    });
    servers.push(mtplx);

    const res = await request(createApp({ connectionFile: absentConnection }))
      .post("/api/ocr")
      .send({ llmBaseUrl: `${mtplx.url}/v1`, llmApiKey: "k", image: PAGE_IMAGE });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("画像に対応したモデル");
  });

  it("refuses a request with nothing to read", async () => {
    const res = await request(createApp({ connectionFile: absentConnection }))
      .post("/api/ocr")
      .send({ llmBaseUrl: "http://x/v1", llmApiKey: "k", image: "こんにちは" });
    expect(res.status).toBe(400);
  });

  it("keeps the page image and the text read off it out of the logs", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const mtplx = await listen((req, res) => {
      readJsonBody(req, () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "SECRET_SCAN" } }] }));
      });
    });
    servers.push(mtplx);

    await request(createApp({ connectionFile: absentConnection }))
      .post("/api/ocr")
      .send({ llmBaseUrl: `${mtplx.url}/v1`, llmApiKey: "k", image: PAGE_IMAGE });

    const dumped = info.mock.calls.map((c) => JSON.stringify(c)).join("\n");
    expect(dumped).not.toContain("SECRET_SCAN");
    expect(dumped).not.toContain(PAGE_IMAGE);
  });
});

describe("connection file on the routes", () => {
  it("prefers a ready file over the request body", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guri-conn-http-"));
    const file = path.join(dir, "connection.json");
    const seen: string[] = [];
    const upstream = await listen((req, res) => {
      seen.push(`${req.url || ""} ${req.headers.authorization || ""}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      if ((req.url || "").includes("/search")) {
        res.end(JSON.stringify({ results: [{ title: "判例", url: "http://example.test", content: "" }] }));
        return;
      }
      if ((req.url || "").includes("/chat")) {
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
        return;
      }
      res.end(JSON.stringify({ data: [{ id: "m" }] }));
    });
    servers.push(upstream);
    fs.writeFileSync(
      file,
      JSON.stringify({ llmBaseUrl: `${upstream.url}/v1`, llmApiKey: "file-key", searxngUrl: upstream.url })
    );
    const app = createApp({ connectionFile: file });
    const body = {
      llmBaseUrl: "http://127.0.0.1:9/v1",
      llmApiKey: "body-key",
      searxngUrl: "http://127.0.0.1:9",
    };

    const health = await request(app).post("/api/health").send(body);
    expect(health.status).toBe(200);
    expect(health.body.llm.ok).toBe(true);
    expect(seen.join("\n")).toContain("file-key");
    expect(seen.join("\n")).not.toContain("body-key");

    seen.length = 0;
    const chat = await request(app).post("/api/chat").send({ ...body, model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(chat.status).toBe(200);
    expect(seen.join("\n")).toContain("file-key");

    const search = await request(app).post("/api/search").send({ q: "判例", searxngUrl: "http://127.0.0.1:9" });
    expect(search.status).toBe(200);
    expect(search.body.results[0].title).toBe("判例");

    const ocr = await request(app).post("/api/ocr").send({ ...body, model: "m", image: "data:image/png;base64,aa", timeoutMs: 5000 });
    expect(ocr.status).toBe(200);

    fs.writeFileSync(file, "{");
    seen.length = 0;
    const broken = await request(app).post("/api/health").send({
      llmBaseUrl: `${upstream.url}/v1`,
      llmApiKey: "body-key",
      searxngUrl: "",
    });
    expect(broken.body.llm.ok).toBe(true);
    expect(seen.join("\n")).toContain("body-key");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not create an empty file and does not log a key from a broken file", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guri-conn-empty-"));
    const file = path.join(dir, "connection.json");
    const app = createApp({ connectionFile: file });
    const empty = await request(app).post("/api/connection").send({ llmBaseUrl: "", llmApiKey: "", searxngUrl: "" });
    expect(empty.body.kind).toBe("absent");
    expect(fs.existsSync(file)).toBe(false);

    fs.writeFileSync(file, '{"llmApiKey":"super-secret-key"');
    const broken = await request(app).get("/api/connection");
    expect(broken.body.kind).toBe("broken");
    expect(JSON.stringify(info.mock.calls)).not.toContain("super-secret-key");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
