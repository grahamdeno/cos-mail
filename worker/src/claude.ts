import type { Env } from "./env";
import { HttpError } from "./errors";
import type { Tool } from "./prompts";

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

/** Per-request tally for the log line: model name and token totals across attempts. */
export interface Meter {
  model: string | null;
  in: number;
  out: number;
}

export interface ToolCall<T> {
  model: string;
  system: string;
  user: string;
  tool: Tool;
  maxTokens: number;
  temperature: number;
  /** Return the parsed value, or null when the tool input is invalid. */
  parse: (input: unknown) => T | null;
}

interface MessagesResponse {
  content?: Array<{ type?: string; name?: string; input?: unknown }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

async function attempt<T>(env: Env, call: ToolCall<T>, meter: Meter): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: call.model,
        max_tokens: call.maxTokens,
        temperature: call.temperature,
        system: call.system,
        tools: [call.tool],
        tool_choice: { type: "tool", name: call.tool.name },
        messages: [{ role: "user", content: call.user }],
      }),
    });
  } catch {
    return null;
  }
  if (!res.ok) {
    // Drain without reading the error text into anything that could be logged.
    await res.body?.cancel();
    return null;
  }
  let data: MessagesResponse;
  try {
    data = (await res.json()) as MessagesResponse;
  } catch {
    return null;
  }
  meter.in += Number(data.usage?.input_tokens ?? 0) || 0;
  meter.out += Number(data.usage?.output_tokens ?? 0) || 0;
  const block = data.content?.find((c) => c.type === "tool_use" && c.name === call.tool.name);
  if (!block) return null;
  try {
    return call.parse(block.input);
  } catch {
    return null;
  }
}

/**
 * A11: Messages API with tool_choice forced to the one tool. One retry on a
 * missing or invalid tool call (or a failed request), then 502 model_error.
 */
export async function callTool<T>(env: Env, call: ToolCall<T>, meter: Meter): Promise<T> {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError("internal");
  meter.model = call.model;
  for (let i = 0; i < 2; i++) {
    const value = await attempt(env, call, meter);
    if (value !== null) return value;
  }
  throw new HttpError("model_error");
}
