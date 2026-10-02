import fs from "fs";
import path from "path";
import express, { NextFunction, Request, Response } from "express";
import { DEFAULT_MODEL, DEFAULT_TIMEOUT_MS, OCR_BODY_LIMIT_BYTES } from "../shared/constants";
import { parseCommittedFiles } from "../shared/fileSource";
import { NewMessage } from "../shared/history";
import { visionUnsupportedMessage } from "../shared/ocr";
import { getHistory } from "./history";
import { rejectReason } from "../shared/fileExtract";
import { checkArgos, listArgosScopes, searchArgos } from "./argos";
import { canReadIndexedPath, noteIndexedHits } from "./indexedPaths";
import { checkLlmHealth, chatCompletions, pipeChatStream, readImageText } from "./llm";
import { logError, logInfo } from "./logger";
import { checkSearxng, getSearchProvider } from "./search";
import {
  adoptConnection,
  connectionFromBody,
  connectionPath,
  connectionPayload,
  Connection,
  readConnection,
  resolveConnection,
  saveConnection,
  sweepConnectionTemps,
} from "./connection";
import {
  ArgosScopesRequestBody,
  ArgosSearchRequestBody,
  ChatRequestBody,
  HealthRequestBody,
  OcrRequestBody,
  SearchRequestBody,
} from "./types";

function clientSignal(res: Response): AbortSignal {
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) {
      ac.abort();
    }
  });
  return ac.signal;
}

function sendError(res: Response, status: number, error: string, hint?: string): void {
  res.status(status).json(hint ? { error, hint } : { error });
}

function textError(error: unknown): string {
  return error instanceof Error ? error.message : "失敗しました。";
}

function activeConnection(file: string, body: unknown): Connection {
  const record =
    body && typeof body === "object"
      ? (body as { llmBaseUrl?: unknown; llmApiKey?: unknown; searxngUrl?: unknown })
      : {};
  return resolveConnection(readConnection(file, (line) => logInfo(line)), record);
}

export function createApp(options: { connectionFile?: string } = {}): express.Express {
  const connectionFile = options.connectionFile ?? connectionPath();
  sweepConnectionTemps(path.dirname(connectionFile));
  const app = express();
  app.disable("x-powered-by");

  /*
   * Registered before the global parser so the small limit never sees it: a
   * page image is base64, which grows it by 4/3, and the global 2MB is what
   * keeps a runaway chat request from being read into memory.
   */
  app.post(
    "/api/ocr",
    express.json({ limit: OCR_BODY_LIMIT_BYTES }),
    async (req: Request<unknown, unknown, OcrRequestBody>, res) => {
      const signal = clientSignal(res);
      const body = req.body || {};
      const image = (body.image || "").trim();
      if (!image.startsWith("data:image/")) {
        sendError(res, 400, "読み取る画像が渡されていません。");
        return;
      }
      logInfo("POST /api/ocr", { status: "start" });
      const connection = activeConnection(connectionFile, body);
      try {
        const text = await readImageText({
          baseUrl: connection.llmBaseUrl,
          apiKey: connection.llmApiKey,
          model: body.model || DEFAULT_MODEL,
          image,
          timeoutMs: body.timeoutMs || DEFAULT_TIMEOUT_MS,
          signal,
        });
        logInfo("POST /api/ocr", { status: 200 });
        res.json({ text });
      } catch (error) {
        if (signal.aborted) {
          sendError(res, 499, "キャンセルしました。");
          return;
        }
        const detail = error instanceof Error ? error.message : "画像の読み取りに失敗しました。";
        const vision = visionUnsupportedMessage(detail);
        sendError(
          res,
          502,
          vision || detail,
          vision ? undefined : (error as { hint?: string }).hint
        );
      }
    }
  );

  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "LexCrew Doc" });
  });

  app.get("/api/connection", (_req, res) => {
    res.json(connectionPayload(readConnection(connectionFile, (line) => logInfo(line))));
  });

  app.post("/api/connection", (req, res) => {
    try {
      res.json(connectionPayload(adoptConnection(connectionFile, connectionFromBody(req.body), (line) => logInfo(line))));
    } catch (error) {
      sendError(res, 500, textError(error));
    }
  });

  app.put("/api/connection", (req, res) => {
    try {
      const next = connectionFromBody(req.body);
      saveConnection(connectionFile, next);
      res.json({ kind: "ready", ...next });
    } catch (error) {
      sendError(res, 500, textError(error));
    }
  });

  app.post("/api/health", async (req: Request<unknown, unknown, HealthRequestBody>, res) => {
    const signal = clientSignal(res);
    const body = req.body || {};
    const connection = activeConnection(connectionFile, body);
    logInfo("POST /api/health", { status: "start" });
    try {
      const llm = await checkLlmHealth(connection.llmBaseUrl, connection.llmApiKey, signal);
      let searxng: { ok: boolean; error?: string } | undefined;
      if (connection.searxngUrl.trim()) {
        searxng = await checkSearxng(connection.searxngUrl, signal);
      }
      let argos: { ok: boolean; error?: string } | undefined;
      if ((body.argosBaseUrl || "").trim()) {
        argos = await checkArgos(body.argosBaseUrl || "", body.argosApiKey, signal);
      }

      logInfo("POST /api/health", { status: llm.ok ? 200 : 503 });
      res.status(llm.ok ? 200 : 503).json({
        sidecar: { ok: true },
        llm,
        searxng,
        argos,
      });
    } catch (error) {
      if (signal.aborted) {
        sendError(res, 499, "キャンセルしました。");
        return;
      }
      logError("health failed", { name: error instanceof Error ? error.name : "error" });
      sendError(res, 500, "接続確認に失敗しました。");
    }
  });

  app.post("/api/chat", async (req: Request<unknown, unknown, ChatRequestBody>, res) => {
    const signal = clientSignal(res);
    const body = req.body || {};
    const connection = activeConnection(connectionFile, body);
    const call = {
      baseUrl: connection.llmBaseUrl,
      apiKey: connection.llmApiKey,
      model: body.model || DEFAULT_MODEL,
      messages: body.messages || [],
      tools: body.tools,
      thinkingLevel: body.thinkingLevel,
      thinkingBudget: body.thinkingBudget,
      timeoutMs: body.timeoutMs || DEFAULT_TIMEOUT_MS,
      signal,
    };
    try {
      if (body.stream) {
        await pipeChatStream(call, res);
        return;
      }
      const result = await chatCompletions(call);
      res.json(result);
    } catch (error) {
      if (signal.aborted) {
        if (!res.headersSent) {
          sendError(res, 499, "キャンセルしました。");
        } else {
          res.end();
        }
        return;
      }
      const message =
        error instanceof Error ? error.message : "MTPLX への問い合わせに失敗しました。";
      const hint = (error as { hint?: string }).hint;
      if (!res.headersSent) {
        sendError(res, 502, message, hint);
      } else {
        res.end();
      }
    }
  });

  app.post("/api/search", async (req: Request<unknown, unknown, SearchRequestBody>, res) => {
    const signal = clientSignal(res);
    const body = req.body || {};
    const connection = activeConnection(connectionFile, body);
    try {
      const results = await getSearchProvider().search(body.q || "", connection.searxngUrl, signal);
      res.json({ provider: "searxng", results });
    } catch (error) {
      if (signal.aborted) {
        sendError(res, 499, "キャンセルしました。");
        return;
      }
      const message = error instanceof Error ? error.message : "検索に失敗しました。";
      sendError(res, 502, message);
    }
  });

  const handleArgosScopes = async (
    res: Response,
    input: { baseUrl: string; apiKey: string; query: string }
  ) => {
    const signal = clientSignal(res);
    try {
      const result = await listArgosScopes(input.baseUrl, input.apiKey, input.query, signal);
      res.json(result);
    } catch (error) {
      if (signal.aborted) {
        sendError(res, 499, "キャンセルしました。");
        return;
      }
      const message = error instanceof Error ? error.message : "Argos の範囲一覧に失敗しました。";
      const hint = (error as { hint?: string }).hint;
      sendError(res, 502, message, hint);
    }
  };

  app.get("/api/argos/scopes", async (req, res) => {
    await handleArgosScopes(res, {
      baseUrl: typeof req.query.argosBaseUrl === "string" ? req.query.argosBaseUrl : "",
      apiKey: typeof req.query.argosApiKey === "string" ? req.query.argosApiKey : "",
      query: typeof req.query.query === "string" ? req.query.query : "",
    });
  });

  app.post(
    "/api/argos/scopes",
    async (req: Request<unknown, unknown, ArgosScopesRequestBody>, res) => {
      const body = req.body || {};
      await handleArgosScopes(res, {
        baseUrl: body.argosBaseUrl || "",
        apiKey: body.argosApiKey || "",
        query: body.query || "",
      });
    }
  );

  app.post(
    "/api/argos/search",
    async (req: Request<unknown, unknown, ArgosSearchRequestBody>, res) => {
      const signal = clientSignal(res);
      const body = req.body || {};
      try {
        const results = await searchArgos(
          body.argosBaseUrl || "",
          body.argosApiKey,
          body.q || "",
          body.pathPrefixes || [],
          signal
        );
        noteIndexedHits(results.map((hit) => hit.url));
        res.json({ provider: "argos", results });
      } catch (error) {
        if (signal.aborted) {
          sendError(res, 499, "キャンセルしました。");
          return;
        }
        const message = error instanceof Error ? error.message : "Argos の検索に失敗しました。";
        const hint = (error as { hint?: string }).hint;
        sendError(res, 502, message, hint);
      }
    }
  );

  app.post("/api/argos/file", async (req: Request<unknown, unknown, { path?: string }>, res) => {
    const filePath = (req.body?.path || "").trim();
    if (!canReadIndexedPath(filePath)) {
      sendError(
        res,
        403,
        "検索結果に無いパスは読めません。search_index の url をそのまま渡してください。"
      );
      return;
    }
    try {
      const stat = await fs.promises.stat(filePath);
      const name = path.basename(filePath);
      const reason = rejectReason({ name, size: stat.size });
      if (reason) {
        sendError(res, 400, reason);
        return;
      }
      const bytes = await fs.promises.readFile(filePath);
      res.json({ name, data: bytes.toString("base64") });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        sendError(res, 404, "ファイルが見つかりません。");
        return;
      }
      sendError(res, 500, textError(error));
    }
  });

  // Conversations live only in the local database. Bodies are never logged.
  app.get("/api/conversations", (req, res) => {
    const documentKey =
      typeof req.query.documentKey === "string" ? req.query.documentKey : undefined;
    res.json({ conversations: getHistory().listConversations(documentKey) });
  });

  app.post(
    "/api/conversations",
    (
      req: Request<
        unknown,
        unknown,
        { documentKey?: string; title?: string; documentPath?: string }
      >,
      res
    ) => {
      const body = req.body || {};
      res.json(
        getHistory().createConversation(body.documentKey || "", body.title, body.documentPath)
      );
    }
  );

  app.put(
    "/api/conversations/document-path",
    (req: Request<unknown, unknown, { documentKey?: string; documentPath?: string }>, res) => {
      const body = req.body || {};
      const updated = getHistory().setDocumentPath(body.documentKey || "", body.documentPath || "");
      res.json({ ok: true, updated });
    }
  );

  app.get("/api/conversations/:id", (req, res) => {
    const detail = getHistory().getConversation(req.params.id);
    if (!detail) {
      sendError(res, 404, "その会話は見つかりませんでした。");
      return;
    }
    res.json(detail);
  });

  app.post(
    "/api/conversations/:id/messages",
    (req: Request<{ id: string }, unknown, NewMessage>, res) => {
      const message = getHistory().appendMessage(req.params.id, req.body || { role: "user" });
      if (!message) {
        sendError(res, 404, "その会話は見つかりませんでした。");
        return;
      }
      res.json(message);
    }
  );

  app.delete("/api/conversations/:id", (req, res) => {
    if (!getHistory().deleteConversation(req.params.id)) {
      sendError(res, 404, "その会話は見つかりませんでした。");
      return;
    }
    res.json({ ok: true });
  });

  app.put(
    "/api/conversations/:id/argos-scope",
    (req: Request<{ id: string }, unknown, { pathPrefixes?: string[] }>, res) => {
      const prefixes = Array.isArray(req.body?.pathPrefixes) ? req.body.pathPrefixes : [];
      const updated = getHistory().setArgosPathPrefix(req.params.id, prefixes);
      if (!updated) {
        sendError(res, 404, "その会話は見つかりませんでした。");
        return;
      }
      res.json(updated);
    }
  );

  // Files are read once and kept on the conversation, so the same PUT both
  // adds what a turn attached and drops what the user took away.
  app.put(
    "/api/conversations/:id/files",
    (req: Request<{ id: string }, unknown, { files?: unknown }>, res) => {
      const files = getHistory().setFiles(req.params.id, parseCommittedFiles(req.body?.files));
      if (!files) {
        sendError(res, 404, "その会話は見つかりませんでした。");
        return;
      }
      res.json({ files });
    }
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logError("unhandled", { name: err instanceof Error ? err.name : "error" });
    if (!res.headersSent) {
      sendError(res, 500, "内部エラーが発生しました。");
    }
  });

  return app;
}
