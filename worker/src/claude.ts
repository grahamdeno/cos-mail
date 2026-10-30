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
  /** The output schema (its input_schema), sent as structured output. The name is kept for logs and tests. */
  tool: Tool;
  maxTokens: number;
  /** Not sent: current models reject temperature. Kept so callers can state intent. */
  temperature?: number;
  /** Return the parsed value, or null when the tool input is invalid. */
  parse: (input: unknown) => T | null;
}

interface MessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
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
      body: JSON.stringify(requestBody(call)),
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
  // Structured output: the JSON is the text block. A refusal or a cut-off answer is not trusted.
  if (data.stop_reason === "refusal" || data.stop_reason === "max_tokens") return null;
  const text = data.content?.find((c) => c.type === "text" && typeof c.text === "string")?.text;
  if (text === undefined) return null;
  try {
    return call.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * The Messages API request. Step 4: structured output (output_config.format, json_schema) instead of a
 * forced tool call, and no temperature. The 5.5 models reject forced tool_choice and temperature.
 */
export function requestBody<T>(call: ToolCall<T>): Record<string, unknown> {
  return {
    model: call.model,
    max_tokens: call.maxTokens,
    system: call.system,
    messages: [{ role: "user", content: call.user }],
    output_config: { format: { type: "json_schema", schema: call.tool.input_schema } },
  };
}

/**
 * Messages API with a structured-output schema. One retry on a missing or invalid
 * answer (or a failed request), then 502 model_error.
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
