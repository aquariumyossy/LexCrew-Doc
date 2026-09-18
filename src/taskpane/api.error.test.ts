import { describe, expect, it } from "vitest";
import { httpErrorMessage } from "./api";

describe("httpErrorMessage", () => {
  it("does not dump Express HTML 404 pages into the UI", () => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head><title>Error</title></head>
<body><pre>Cannot GET /api/argos/scopes</pre></body>
</html>`;
    expect(httpErrorMessage(html, 404)).toMatch(/起動し直/);
    expect(httpErrorMessage(html, 404)).not.toContain("<html");
  });

  it("keeps a JSON error string", () => {
    expect(httpErrorMessage('{"error":"Argos に接続できませんでした。"}', 502)).toBe(
      "Argos に接続できませんでした。"
    );
  });
});
