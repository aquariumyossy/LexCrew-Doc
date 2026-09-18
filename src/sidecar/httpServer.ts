import https from "https";
import path from "path";
import express from "express";
import { HOST, PORT } from "../shared/constants";
import { createApp } from "./app";
import { logInfo } from "./logger";

export type StartServerOptions = {
  production: boolean;
  staticDir?: string;
};

export async function startServer(options: StartServerOptions): Promise<https.Server> {
  const app = createApp();

  app.get("/", (_req, res) => {
    res.redirect("/taskpane.html");
  });

  if (options.production) {
    const staticDir = options.staticDir ?? path.resolve(__dirname, "..", "..", "dist");
    app.use(
      express.static(staticDir, {
        etag: false,
        setHeaders(res) {
          // Office refuses to use ribbon images it may not store, so revalidate
          // instead of sending no-store.
          res.setHeader("Cache-Control", "no-cache, must-revalidate");
        },
      })
    );
  } else {
    const webpack = require("webpack") as typeof import("webpack");
    const webpackDevMiddleware = require("webpack-dev-middleware") as (
      compiler: import("webpack").Compiler,
      opts: { publicPath: string; headers?: Record<string, string> }
    ) => express.RequestHandler;
    const webpackConfigFactory = require("../../webpack.config.js") as (
      env: Record<string, unknown>,
      argv: { mode: string }
    ) => import("webpack").Configuration;
    const config = webpackConfigFactory({}, { mode: "development" });
    const compiler = webpack(config);
    const webpackMiddleware = webpackDevMiddleware(compiler, {
      publicPath: "/",
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
    app.use((req, res, next) => {
      if (req.path.startsWith("/api/")) {
        next();
        return;
      }
      webpackMiddleware(req, res, next);
    });
  }

  const { getHttpsServerOptions } = require("office-addin-dev-certs") as {
    getHttpsServerOptions: () => Promise<{
      ca: Buffer | string;
      key: Buffer | string;
      cert: Buffer | string;
    }>;
  };
  const httpsOptions = await getHttpsServerOptions();
  const server = https.createServer(
    {
      ca: httpsOptions.ca,
      key: httpsOptions.key,
      cert: httpsOptions.cert,
    },
    app
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, () => {
      logInfo(`listening https://${HOST}:${PORT}`);
      resolve();
    });
  });

  return server;
}
