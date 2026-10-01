export type UiFontSize = "small" | "medium" | "large";

/** KURU uses a 14px root. Small and large are 12px and 16px on that root. */
const UI_FONT_ROOT_PX: Record<UiFontSize, number> = {
  small: 12,
  medium: 14,
  large: 16,
};

export const UI_FONT_SCALE_VAR = "--guri-ui-scale";

export function normalizeUiFontSize(value: unknown): UiFontSize {
  if (value === "small" || value === "medium" || value === "large") return value;
  return "medium";
}

export function uiFontScale(size: UiFontSize): number {
  return UI_FONT_ROOT_PX[size] / UI_FONT_ROOT_PX.medium;
}

export function uiPx(px: number): string {
  return `calc(${px}px * var(${UI_FONT_SCALE_VAR}, 1))`;
}

/** Theme token lengths stay in px until this wraps them in the same scale. */
export function scaleThemeLength(value: string): string {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value);
  if (!match) return value;
  return uiPx(Number(match[1]));
}

export function readUiFontScale(): number {
  const raw = document.documentElement.style.getPropertyValue(UI_FONT_SCALE_VAR).trim();
  const scale = Number(raw);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function applyUiFont(size: UiFontSize): void {
  const root = document.documentElement;
  root.dataset.uiFont = size;
  root.style.setProperty(UI_FONT_SCALE_VAR, String(uiFontScale(size)));
}
