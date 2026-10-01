export type ConnectionFields = {
  llmBaseUrl: string;
  llmApiKey: string;
  searxngUrl: string;
};

export type ConnectionView =
  | ({ kind: "ready" } & ConnectionFields)
  | { kind: "absent" }
  | { kind: "broken" };

export function applyAdopt<T extends ConnectionFields>(
  settings: T,
  result: ConnectionView
): { settings: T; keepConnection: boolean } {
  if (result.kind === "ready") {
    return {
      settings: {
        ...settings,
        llmBaseUrl: result.llmBaseUrl,
        llmApiKey: result.llmApiKey,
        searxngUrl: result.searxngUrl,
      },
      keepConnection: false,
    };
  }
  return { settings, keepConnection: result.kind === "broken" };
}

export function settingsForStorage<T extends ConnectionFields>(
  settings: T,
  keepConnection: boolean
): T | Omit<T, keyof ConnectionFields> {
  if (keepConnection) return settings;
  const { llmBaseUrl: _llmBaseUrl, llmApiKey: _llmApiKey, searxngUrl: _searxngUrl, ...rest } = settings;
  return rest;
}
