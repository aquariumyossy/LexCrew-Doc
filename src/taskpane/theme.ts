import { BrandVariants, Theme, createLightTheme } from "@fluentui/react-components";
import { scaleThemeLength } from "./uiFont";

/** 参照イラストの服と同じアズール。薄い段も彩度を落とさない。 */
const guriBrand: BrandVariants = {
  10: "#091720",
  20: "#0d2230",
  30: "#102e42",
  40: "#0f3a57",
  50: "#0c476e",
  60: "#075183",
  70: "#045890",
  80: "#025b97",
  90: "#1282ba",
  100: "#24a4db",
  110: "#54b5de",
  120: "#7dcbe8",
  130: "#9fdaef",
  140: "#b8e4f4",
  150: "#d2eff9",
  160: "#e4f5fc",
};

const theme = createLightTheme(guriBrand);

function withUiFontScale(base: Theme): Theme {
  const next = { ...base };
  for (const key of Object.keys(next) as (keyof Theme)[]) {
    const name = String(key);
    if (!name.startsWith("fontSize") && !name.startsWith("lineHeight")) continue;
    const value = next[key];
    if (typeof value !== "string") continue;
    (next as Record<string, string | number>)[name] = scaleThemeLength(value);
  }
  return next;
}

/** Word 作業ウィンドウ用。キャンバスは白、ブランド色はユーザー吹き出しなどに残す。 */
export const guriLightTheme: Theme = withUiFontScale({
  ...theme,
  colorBrandBackground2: "#bae4f4",
  colorBrandBackground2Hover: "#d2eff9",
  colorBrandBackground2Pressed: "#9fdaef",
  colorNeutralBackground1: "#ffffff",
  colorNeutralBackground1Hover: "#f5f5f5",
  colorNeutralBackground1Pressed: "#ebebeb",
  colorNeutralBackground1Selected: "#f0f0f0",
  colorNeutralBackground2: "#fafafa",
  colorNeutralBackground2Hover: "#f5f5f5",
  colorNeutralBackground2Pressed: "#ebebeb",
  colorNeutralBackground2Selected: "#f0f0f0",
  colorNeutralBackground3: "#f5f5f5",
  colorNeutralBackground3Hover: "#ebebeb",
  colorNeutralBackground3Pressed: "#e0e0e0",
  colorNeutralBackground3Selected: "#f0f0f0",
  colorNeutralBackground4: "#fafafa",
  colorNeutralBackground5: "#f5f5f5",
  colorNeutralBackground6: "#f0f0f0",
  colorNeutralForeground1: "#0e344e",
  colorNeutralForeground1Hover: "#0e344e",
  colorNeutralForeground1Pressed: "#0e344e",
  colorNeutralForeground1Selected: "#0e344e",
  colorNeutralForeground2: "#1f5674",
  colorNeutralForeground3: "#3f6c83",
  colorNeutralForeground4: "#4d7d99",
  colorNeutralStroke1: "#94c8db",
  colorNeutralStroke1Hover: "#7dcbe8",
  colorNeutralStroke1Pressed: "#54b5de",
  colorNeutralStroke2: "#b8ddea",
  colorNeutralStroke3: "#d2eff9",
  colorNeutralStrokeAccessible: "#025b97",
  colorSubtleBackgroundHover: "#d2eff9",
  colorSubtleBackgroundPressed: "#bae4f4",
  colorSubtleBackgroundSelected: "#c5ebf7",
  colorNeutralCardBackground: "#ffffff",
  colorNeutralCardBackgroundHover: "#ffffff",
  colorNeutralCardBackgroundPressed: "#f5f5f5",
  colorNeutralCardBackgroundSelected: "#f0f0f0",
});
