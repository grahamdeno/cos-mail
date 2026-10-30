import { callTool } from "../claude";
import { DRAFT_TOOL, draftSystem, mailBlock } from "../prompts";
import { findBlanks } from "../quote";
import { BODY_MAX, ID_MAX, SHORT_MAX, arr, bool, isObj, obj, oneOf, str } from "../validate";
import type { Handler } from "./context";
import { optSubject, parseMessage } from "./mail";

export function parseDraftOutput(input: unknown): { subject: string; body: string } | null {
  if (!isObj(input) || typeof input.subject !== "string" || typeof input.body !== "string") return null;
  if (input.body.trim() === "") return null;
  return { subject: input.subject.slice(0, 200), body: input.body.slice(0, 4000) };
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

  const out = await callTool(
    ctx.env,
    {
      model: ctx.env.MODEL_DRAFT,
      system: draftSystem(ctx.tester.name, ctx.tester.email),
      user:
        `shorter: ${shorter}\n\n` +
        mailBlock({ thread_id, subject, messages, decision, answer, style_examples }),
      tool: DRAFT_TOOL,
      maxTokens: 1000,
      temperature: 0.4,
      parse: parseDraftOutput,
    },
    ctx.meter,
  );

  return {
    subject: out.subject,
    body: out.body,
    blanks: findBlanks(`${out.subject}\n${out.body}`),
    usage: { input_tokens: ctx.meter.in, output_tokens: ctx.meter.out },
  };
};
