import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LOG_KEYS } from "../src/log";
import { allow, call, idToken, installFetch, makeEnv, setupKeys, type FetchMock } from "./helpers";

let mock: FetchMock;
let lines: string[];

beforeAll(setupKeys);
beforeEach(async () => {
  mock = await installFetch();
  lines = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation(capture);
});
afterEach(() => vi.restoreAllMocks());

// Distinctive strings that must never reach a log line.
const MAIL_TEXT = "ZEBRA-PINEAPPLE quarterly kitchen refit at 41 Larkspur Lane";
const SUBJECT = "SUBJ-Moonlit-Gazebo-7781";
const PERSON = "Quillon Featherstonehaugh";
const OTHER_EMAIL = "quillon.f@uniquehost.example";
const QUOTE = "I'll deliver the ZEBRA-PINEAPPLE plans";
const MODEL_TEXT = "MODEL-OUTPUT-Velvet-Harbinger";

describe("logging (A12)", () => {
  it("one line per request, only the A12 keys, and no mail, subject, email, token or model output", async () => {
    const { env, kv } = makeEnv();
    await allow(kv);
    const token = await idToken();
    const msg = { id: "m1", thread_id: "t1", from: `${PERSON} <${OTHER_EMAIL}>`, to: ["maria.tester@example.com"], cc: [], date: "2026-10-29T14:02:00Z", subject: SUBJECT, labels: ["INBOX"], body: `${MAIL_TEXT}. ${QUOTE} by Friday.` };

    const requests: Array<() => Promise<unknown>> = [];
    mock.replies.push({ tool: "record_sort", input: { results: [{ id: "m1", verdict: "needs_you", group: null, reason: MODEL_TEXT }] } });
    requests.push(() => call(env, "/api/sort", { mode: "daily", messages: [msg] }, { token }));
    mock.replies.push({
      tool: "record_items",
      input: {
        commitments: [
          { thread_id: "t1", direction: "owed_to_me", person: PERSON, what: MODEL_TEXT, quote: QUOTE, quote_message_id: "m1", due: null, due_kind: null, status: "open", confidence: "high" },
          { thread_id: "t1", direction: "owed_to_me", person: PERSON, what: MODEL_TEXT, quote: "invented " + MODEL_TEXT, quote_message_id: "m1", due: null, due_kind: null, status: "open", confidence: "low" },
        ],
        decisions: [],
      },
    });
    requests.push(() => call(env, "/api/extract", { mode: "daily", today: "2026-10-30", threads: [{ thread_id: "t1", subject: SUBJECT, messages: [msg] }] }, { token }));
    mock.replies.push({ tool: "write_draft", input: { subject: `Re: ${SUBJECT}`, body: MODEL_TEXT } });
    requests.push(() =>
      call(env, "/api/draft", {
        thread_id: "t1",
        subject: SUBJECT,
        messages: [msg],
        decision: { question: MAIL_TEXT, recommended: "Yes" },
        answer: { kind: "own_words", text: MAIL_TEXT },
        style_examples: [{ to: OTHER_EMAIL, date: "2026-10-02T12:00:00Z", body: MAIL_TEXT }],
      }, { token }),
    );
    requests.push(() => call(env, "/api/share", { label: "missed_one", note: MAIL_TEXT, example: { thread_id: "t1", subject: SUBJECT, messages: [msg], model_output: { what: MODEL_TEXT }, correction: null } }, { token }));
    requests.push(() => call(env, "/api/labels", { day: "2026-10-30", counts: { needed_me: 1 } }, { token }));
    // Error paths too: bad schema, model failure, unauthorized, not on list, unknown path.
    requests.push(() => call(env, "/api/sort", { messages: [{ ...msg, from: 42 }] }, { token }));
    mock.replies.push({ text: MODEL_TEXT }, { text: MODEL_TEXT });
    requests.push(() => call(env, "/api/sort", { messages: [msg] }, { token }));
    requests.push(() => call(env, "/api/sort", { messages: [msg] }, { token: token + "x" }));
    requests.push(async () => call(env, "/api/sort", { messages: [msg] }, { token: await idToken({ email: OTHER_EMAIL }) }));
    requests.push(() => call(env, `/api/${SUBJECT}`, { messages: [msg] }, { token }));

    const statuses: number[] = [];
    for (const r of requests) statuses.push(((await r()) as { status: number }).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 400, 502, 401, 403, 404]);

    expect(lines).toHaveLength(requests.length);
    const forbidden = [MAIL_TEXT, "ZEBRA", SUBJECT, "Moonlit", PERSON, OTHER_EMAIL, "maria.tester@example.com", "uniquehost", QUOTE, MODEL_TEXT, "Velvet", token, token.slice(0, 40), "Bearer", "<mail>"];
    for (const line of lines) {
      for (const f of forbidden) expect(line).not.toContain(f);
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(parsed)).toEqual([...LOG_KEYS]);
      expect(parsed.t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(parsed.tester === null || /^[0-9a-f]{16}$/.test(String(parsed.tester))).toBe(true);
      expect(["/api/sort", "/api/extract", "/api/draft", "/api/share", "/api/labels", "other"]).toContain(parsed.endpoint);
      expect(parsed.model === null || /^claude-[a-z0-9-]+$/.test(String(parsed.model))).toBe(true);
      expect(typeof parsed.in).toBe("number");
      expect(typeof parsed.out).toBe("number");
      expect(typeof parsed.status).toBe("number");
      expect(typeof parsed.ms).toBe("number");
    }
    const first = JSON.parse(lines[0]!);
    expect(first).toMatchObject({ endpoint: "/api/sort", model: "claude-haiku-5-5", in: 100, out: 20, status: 200 });
    expect(JSON.parse(lines[7]!)).toMatchObject({ tester: null, status: 401, model: null });
    expect(JSON.parse(lines[9]!)).toMatchObject({ endpoint: "other", status: 404 });
  });
});
