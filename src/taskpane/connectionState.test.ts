import { describe, expect, it } from "vitest";
import { applyAdopt, settingsForStorage } from "./connectionState";

const stored = {
  llmBaseUrl: "http://local",
  llmApiKey: "local-key",
  llmModel: "qwen",
  searxngUrl: "http://local-searx",
};

describe("applyAdopt", () => {
  it("takes the file and drops the three keys from storage", () => {
    const applied = applyAdopt(stored, {
      kind: "ready",
      llmBaseUrl: "http://file",
      llmApiKey: "file-key",
      searxngUrl: "",
    });
    expect(applied.keepConnection).toBe(false);
    expect(applied.settings.llmBaseUrl).toBe("http://file");
    expect(applied.settings.llmModel).toBe("qwen");
    expect(settingsForStorage(applied.settings, applied.keepConnection)).toEqual({ llmModel: "qwen" });
  });

  it("keeps the three keys when the file is broken", () => {
    const applied = applyAdopt(stored, { kind: "broken" });
    expect(applied.keepConnection).toBe(true);
    expect(settingsForStorage(applied.settings, applied.keepConnection)).toEqual(stored);
  });

  it("does not keep empty keys when the file is absent", () => {
    const applied = applyAdopt(stored, { kind: "absent" });
    expect(applied.keepConnection).toBe(false);
    expect(applied.settings).toEqual(stored);
    expect(settingsForStorage(applied.settings, false)).toEqual({ llmModel: "qwen" });
  });

  it("does not refill an empty ready file from stored values", () => {
    const applied = applyAdopt(stored, {
      kind: "ready",
      llmBaseUrl: "",
      llmApiKey: "",
      searxngUrl: "",
    });
    expect(applied.settings.llmBaseUrl).toBe("");
    expect(applied.settings.llmApiKey).toBe("");
    expect(applied.settings.llmModel).toBe("qwen");
    expect(settingsForStorage(applied.settings, false)).toEqual({ llmModel: "qwen" });
  });
});
