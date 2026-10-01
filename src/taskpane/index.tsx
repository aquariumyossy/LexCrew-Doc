import * as React from "react";
import { createRoot } from "react-dom/client";
import { FluentProvider } from "@fluentui/react-components";
import App from "./components/App";
import { loadSettings } from "./settings";
import { guriLightTheme } from "./theme";
import { applyUiFont } from "./uiFont";

/* global document, Office, module, HTMLElement */

const rootElement: HTMLElement | null = document.getElementById("container");
const root = rootElement ? createRoot(rootElement) : undefined;

function render(): void {
  applyUiFont(loadSettings().uiFontSize);
  root?.render(
    <FluentProvider theme={guriLightTheme} style={{ minHeight: "100%", backgroundColor: "#ffffff" }}>
      <App />
    </FluentProvider>
  );
}

Office.onReady(() => {
  render();
});

if (
  (module as unknown as { hot?: { accept: (path: string | string[], cb: () => void) => void } }).hot
) {
  (module as unknown as { hot: { accept: (path: string | string[], cb: () => void) => void } }).hot.accept(
    ["./components/App", "./theme"],
    () => {
      render();
    }
  );
}
