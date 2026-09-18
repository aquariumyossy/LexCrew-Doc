import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ARGOS_BASE_URL,
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_TIMEOUT_MS,
  LEGACY_DEFAULT_CONTEXT_LIMIT,
  LEGACY_DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  SETTINGS_STORAGE_KEY,
} from "../shared/constants";
import { clampTimeoutMs, loadSettings } from "./settings";
import { MAX_TOOL_ROUNDS, UNLIMITED_TOOL_ROUNDS } from "../shared/tools";

const memory = new Map<string, string>();

describe("clampTimeoutMs", () => {
  it("keeps values inside the allowed window", () => {
    expect(clampTimeoutMs(120_000)).toBe(120_000);
    expect(clampTimeoutMs(1_000)).toBe(MIN_TIMEOUT_MS);
    expect(clampTimeoutMs(9_999_000)).toBe(MAX_TIMEOUT_MS);
  });
});

describe("loadSettings timeout migration", () => {
  beforeEach(() => {
    memory.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
      removeItem: (key: string) => {
        memory.delete(key);
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("promotes the old 180s default to the new wait", () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ timeoutMs: LEGACY_DEFAULT_TIMEOUT_MS })
    );
    expect(loadSettings().timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("keeps a timeout the user set on purpose", () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ timeoutMs: 300_000 }));
    expect(loadSettings().timeoutMs).toBe(300_000);
  });

  it("defaults Argos to the loopback search API", () => {
    expect(loadSettings().argosBaseUrl).toBe(DEFAULT_ARGOS_BASE_URL);
    expect(loadSettings().argosApiKey).toBe("");
  });

  it("promotes the old window, which was too narrow to attach a contract", () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ contextLimit: LEGACY_DEFAULT_CONTEXT_LIMIT })
    );
    expect(loadSettings().contextLimit).toBe(DEFAULT_CONTEXT_LIMIT);
  });

  it("keeps a window the user set on purpose", () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ contextLimit: 100_000 }));
    expect(loadSettings().contextLimit).toBe(100_000);
  });

  it("falls back to the default when the stored window is nonsense", () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ contextLimit: -5 }));
    expect(loadSettings().contextLimit).toBe(DEFAULT_CONTEXT_LIMIT);
  });

  it("defaults the tool-round cap and keeps unlimited", () => {
    expect(loadSettings().maxToolRounds).toBe(MAX_TOOL_ROUNDS);
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ maxToolRounds: 0 }));
    expect(loadSettings().maxToolRounds).toBe(UNLIMITED_TOOL_ROUNDS);
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ maxToolRounds: 32 }));
    expect(loadSettings().maxToolRounds).toBe(32);
  });
});
