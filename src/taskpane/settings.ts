import {
  DEFAULT_ARGOS_BASE_URL,
  DEFAULT_BODY_PT,
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_FONT_NAME,
  DEFAULT_MODEL,
  DEFAULT_THINKING_BUDGET,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TITLE_PT,
  FALLBACK_FONT_NAME,
  LEGACY_DEFAULT_CONTEXT_LIMIT,
  LEGACY_DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  SETTINGS_STORAGE_KEY,
} from "../shared/constants";
import { ThinkingLevel, normalizeThinkingBudget, normalizeThinkingLevel } from "../shared/thinking";
import { MAX_TOOL_ROUNDS, normalizeMaxToolRounds } from "../shared/tools";

/* global localStorage */

export type Settings = {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  timeoutMs: number;
  searxngUrl: string;
  argosBaseUrl: string;
  argosApiKey: string;
  fontName: string;
  bodyPt: number;
  titlePt: number;
  thinkingLevel: ThinkingLevel;
  thinkingBudget: number;
  contextLimit: number;
  /** 0 means no cap. */
  maxToolRounds: number;
};

export const DEFAULT_SETTINGS: Settings = {
  llmBaseUrl: "",
  llmApiKey: "",
  llmModel: DEFAULT_MODEL,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  searxngUrl: "",
  argosBaseUrl: DEFAULT_ARGOS_BASE_URL,
  argosApiKey: "",
  fontName: DEFAULT_FONT_NAME,
  bodyPt: DEFAULT_BODY_PT,
  titlePt: DEFAULT_TITLE_PT,
  thinkingLevel: "medium",
  thinkingBudget: DEFAULT_THINKING_BUDGET,
  contextLimit: DEFAULT_CONTEXT_LIMIT,
  maxToolRounds: MAX_TOOL_ROUNDS,
};

export const FONT_CHOICES = [DEFAULT_FONT_NAME, FALLBACK_FONT_NAME];

export function clampTimeoutMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(value)));
}

function migrateTimeoutMs(value: unknown): number {
  if (typeof value === "number" && Math.round(value) === LEGACY_DEFAULT_TIMEOUT_MS) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (typeof value !== "number") {
    return DEFAULT_TIMEOUT_MS;
  }
  return clampTimeoutMs(value);
}

/**
 * The old window was too narrow to attach a whole contract, so anyone still on
 * that default moves up. A window the user chose is left alone.
 */
function migrateContextLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_CONTEXT_LIMIT;
  }
  const rounded = Math.round(value);
  return rounded === LEGACY_DEFAULT_CONTEXT_LIMIT ? DEFAULT_CONTEXT_LIMIT : rounded;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    return {
      ...merged,
      timeoutMs: migrateTimeoutMs(merged.timeoutMs),
      thinkingLevel: normalizeThinkingLevel(merged.thinkingLevel),
      thinkingBudget: normalizeThinkingBudget(merged.thinkingBudget),
      contextLimit: migrateContextLimit(merged.contextLimit),
      maxToolRounds: normalizeMaxToolRounds(merged.maxToolRounds),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}
