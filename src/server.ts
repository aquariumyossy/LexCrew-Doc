import { startServer } from "./sidecar/httpServer";
import { logError } from "./sidecar/logger";

const production = process.env.NODE_ENV === "production";

startServer({ production }).catch((error) => {
  logError("server failed", { name: error instanceof Error ? error.name : "error" });
  process.exit(1);
});
