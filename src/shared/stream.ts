import { Completion, Usage, parseCompletion, stripThinking } from "./stripThinking";
import { ToolCall } from "./tools";

export type StreamSnapshot = {
  content: string;
  reasoningContent: string;
};

type ToolAcc = {
  index: number;
  id: string;
  name: string;
  arguments: string;
};

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  return input as Record<string, unknown>;
}

function asArray(input: unknown): unknown[] {
  return Array.isArray(input) ? input : [];
}

function textOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(textOf).join("");
  }
  const row = asRecord(value);
  if (row && typeof row.text === "string") {
    return row.text;
  }
  return "";
}

function firstText(values: unknown[]): string {
  for (const value of values) {
    const text = textOf(value);
    if (text) {
      return text;
    }
  }
  return "";
}

function errorMessage(payload: Record<string, unknown>): string {
  const error = payload.error;
  if (typeof error === "string") {
    return error;
  }
  const row = asRecord(error);
  if (row && typeof row.message === "string") {
    return row.message;
  }
  return "";
}

/**
 * Assemble OpenAI-compatible SSE chunks (`delta.content`, `delta.reasoning_content`,
 * `delta.tool_calls`) into a Completion. Twin of Argos `StreamParse`.
 */
export class StreamAccumulator {
  private content = "";
  private reasoning = "";
  private finishReason = "";
  private usage: Usage | null = null;
  private tools: ToolAcc[] = [];

  snapshot(): StreamSnapshot {
    return { content: this.content, reasoningContent: this.reasoning };
  }

  ingest(payload: unknown): StreamSnapshot {
    const root = asRecord(payload);
    if (!root) {
      return this.snapshot();
    }
    const err = errorMessage(root);
    if (err) {
      throw new Error(err);
    }

    const choice = asRecord(asArray(root.choices)[0]);
    const delta = asRecord(choice?.delta);
    const message = asRecord(choice?.message);

    if (delta) {
      this.content += firstText([delta.content, delta.text]);
      this.reasoning += firstText([delta.reasoning_content, delta.reasoning]);
      this.mergeTools(asArray(delta.tool_calls));
      this.mergeFunctionCall(delta.function_call);
    } else if (message) {
      const done = parseCompletion(payload);
      this.content = done.content;
      this.reasoning = done.reasoningContent;
      this.tools = done.toolCalls.map((call, index) => ({
        index,
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      }));
      this.finishReason = done.finishReason || this.finishReason;
      if (done.usage) {
        this.usage = done.usage;
      }
    } else if (choice) {
      this.content += textOf(choice.text);
    }

    const reason = typeof choice?.finish_reason === "string" ? choice.finish_reason : "";
    if (reason) {
      this.finishReason = reason;
    }
    const usage = parseCompletion({ usage: root.usage }).usage;
    if (root.usage && usage) {
      this.usage = usage;
    }
    return this.snapshot();
  }

  finish(): Completion {
    const toolCalls: ToolCall[] = this.tools
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((tool, index) => ({
        id: tool.id.trim() || `call_${index}`,
        type: "function" as const,
        function: { name: tool.name, arguments: tool.arguments },
      }))
      .filter((call) => call.function.name.trim());

    return {
      content: stripThinking(this.content),
      reasoningContent: this.reasoning,
      toolCalls,
      finishReason: this.finishReason || (toolCalls.length ? "tool_calls" : "stop"),
      usage: this.usage,
    };
  }

  private mergeTools(items: unknown[]): void {
    items.forEach((item) => {
      const row = asRecord(item);
      if (!row) {
        return;
      }
      const index =
        typeof row.index === "number" && Number.isFinite(row.index)
          ? row.index
          : (this.tools.at(-1)?.index ?? 0);
      let slot = this.tools.find((tool) => tool.index === index);
      if (!slot) {
        slot = { index, id: "", name: "", arguments: "" };
        this.tools.push(slot);
      }
      if (typeof row.id === "string" && row.id) {
        slot.id = row.id;
      }
      const fn = asRecord(row.function);
      if (fn) {
        if (typeof fn.name === "string" && fn.name) {
          slot.name = fn.name;
        }
        if (typeof fn.arguments === "string") {
          slot.arguments += fn.arguments;
        } else if (fn.arguments && typeof fn.arguments === "object") {
          slot.arguments += JSON.stringify(fn.arguments);
        }
      }
    });
  }

  private mergeFunctionCall(value: unknown): void {
    const fn = asRecord(value);
    if (!fn) {
      return;
    }
    this.mergeTools([
      {
        index: 0,
        id: "call_0",
        function: fn,
      },
    ]);
  }
}

/** Pull `data:` payloads out of an SSE buffer. Incomplete trailing data stays in the buffer. */
export function takeSseData(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  let rest = buffer;
  while (true) {
    const nl = rest.indexOf("\n");
    if (nl < 0) {
      break;
    }
    const line = rest.slice(0, nl).replace(/\r$/, "");
    rest = rest.slice(nl + 1);
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const data = trimmed.slice("data:".length).trim();
    if (data) {
      events.push(data);
    }
  }
  return { events, rest };
}
