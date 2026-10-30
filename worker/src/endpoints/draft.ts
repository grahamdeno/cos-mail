import { callTool } from "../claude";
import { DRAFT_TOOL, draftSystem, mailBlock } from "../prompts";
import { findBlanks } from "../quote";
import { BODY_MAX, ID_MAX, SHORT_MAX, arr, bool, isObj, obj, oneOf, str } from "../validate";
import type { Handler } from "./context";
import { optSubject, parseMessage } from "./mail";

/** House style: no em-dashes. " — " becomes ", " and a bare "—" becomes "-". */
export function noEmDash(s: string): string {
  return s.replace(/\s*\u2014\s*/g, (m) => (/\s/.test(m) ? ", " : "-"));
}

export function parseDraftOutput(input: unknown): { subject: string; body: string } | null {
  if (!isObj(input) || typeof input.subject !== "string" || typeof input.body !== "string") return null;
  if (input.body.trim() === "") return null;
  return { subject: noEmDash(input.subject).slice(0, 200), body: noEmDash(input.body).slice(0, 4000) };
}

/** The model call for /draft. Shared with the prompt eval (worker/eval). */
export function draftCall(model: string, tester: { name: string; email: string }, data: unknown, shorter: boolean) {
  return {
    model,
    system: draftSystem(tester.name, tester.email),
    user: `shorter: ${shorter}\n\n` + mailBlock(data),
    tool: DRAFT_TOOL,
    maxTokens: 1000,
    temperature: 0.4,
    parse: parseDraftOutput,
  };
}

export const draft: Handler = async (ctx) => {
  const body = obj(ctx.body, "body");
  const thread_id = str(body, "thread_id", "thread_id", { nonEmpty: true, max: ID_MAX });
  const subject = optSubject(body, "subject");
  const messages = arr(body, "messages", "messages", { min: 1, max: 8 }).map((m, i) =>
    parseMessage(m, `messages[${i}]`, { requireTo: false }),
  );
  const d = obj(body.decision, "decision");
  const decision = {
    question: str(d, "question", "decision.question", { max: BODY_MAX, limitIs413: true }),
    recommended: str(d, "recommended", "decision.recommended", { max: SHORT_MAX }),
  };
  const a = obj(body.answer, "answer");
  const answer = {
    kind: oneOf(a, "kind", "answer.kind", ["recommended", "alternate", "own_words"] as const),
    text: str(a, "text", "answer.text", { nonEmpty: true, max: BODY_MAX, limitIs413: true }),
  };
  const style = body.style_examples === undefined ? [] : arr(body, "style_examples", "style_examples", { min: 0, max: 5 });
  const style_examples = style.map((s, i) => {
    const field = `style_examples[${i}]`;
    const o = obj(s, field);
    return {
      to: str(o, "to", `${field}.to`, { max: SHORT_MAX }),
      date: str(o, "date", `${field}.date`, { max: 64 }),
      body: str(o, "body", `${field}.body`, { max: BODY_MAX, limitIs413: true }),
    };
  });
  const shorter = bool(body, "shorter", "shorter", false);

  await ctx.charge("draft", "daily");

  const out = await callTool(ctx.env, draftCall(ctx.env.MODEL_DRAFT, ctx.tester, { thread_id, subject, messages, decision, answer, style_examples }, shorter), ctx.meter);

  return {
    subject: out.subject,
    body: out.body,
    blanks: findBlanks(`${out.subject}\n${out.body}`),
    usage: { input_tokens: ctx.meter.in, output_tokens: ctx.meter.out },
  };
};
