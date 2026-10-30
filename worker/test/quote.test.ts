import { describe, expect, it } from "vitest";
import { checkQuote, emailOf, normalize, quoteInBody } from "../src/quote";

describe("quote check normalization", () => {
  it("a straight-quote model quote matches a body with curly quotes", () => {
    const body = "Maria wrote: \u201CI\u2019ll send the revised quote by Monday.\u201D Thanks!";
    expect(quoteInBody(`"I'll send the revised quote by Monday."`, body)).toBe(true);
  });

  it("a curly-quote model quote matches a body with straight quotes", () => {
    const body = `Maria wrote: "I'll send the revised quote by Monday." Thanks!`;
    expect(quoteInBody("\u201CI\u2019ll send the revised quote by Monday.\u201D", body)).toBe(true);
    expect(quoteInBody("\u2018soft-close\u2019 \u201Ehinges\u2033", `'soft-close' "hinges"`)).toBe(true);
  });

  it("an en dash matches a hyphen (and em dash, figure dash, minus)", () => {
    expect(quoteInBody("Nov 9-16", "Can we do Nov 9\u201316?")).toBe(true);
    expect(quoteInBody("Nov 9\u201316", "Can we do Nov 9-16?")).toBe(true);
    expect(quoteInBody("a - b - c - d", "A \u2014 b \u2012 c \u2212 d")).toBe(true);
  });

  it("ellipsis, primes and zero-width characters", () => {
    expect(quoteInBody("wait...", "Wait\u2026 what?")).toBe(true);
    expect(quoteInBody("6'2\"", "He is 6\u20322\u2033 tall")).toBe(true);
    expect(quoteInBody("revised quote", "re\u200Bvised\u200C qu\u200Dote\uFEFF")).toBe(true);
    expect(normalize("\uFEFF  A\u200B\n\tB  ")).toBe("a b");
  });

  it("still rejects quotes that are not in the body", () => {
    expect(quoteInBody("I'll pay you tomorrow", "I\u2019ll send the quote tomorrow")).toBe(false);
    expect(quoteInBody("\u200B\u200B", "anything")).toBe(false);
  });
});

describe("step 4 quote check", () => {
  const msgs = new Map([
    ["a", { thread_id: "t1", from: "Maria <maria@example.com>", body: "I\u2019ll call you Monday about the trim order." }],
    ["b", { thread_id: "t1", from: "Dave Lee <DAVE@example.com>", body: "Can you confirm 40 board feet? I will send the invoice Friday." }],
    ["c", { thread_id: "t2", from: "maria@example.com", body: "Sure, Thursday works for me." }],
  ]);
  const me = "Maria@Example.com";
  const item = (thread_id: string, quote: string, quote_message_id: string) => ({ thread_id, quote, quote_message_id });

  it("keeps a tester promise quoted from the tester's own message", () => {
    expect(checkQuote(item("t1", "I'll call you Monday", "a"), "i_owe", msgs, me)).toBeNull();
    expect(checkQuote(item("t2", "Thursday works for me", "c"), "i_owe", msgs, me)).toBeNull();
  });
  it("keeps the other person's promise and question quoted from their message", () => {
    expect(checkQuote(item("t1", "I will send the invoice Friday", "b"), "owed_to_me", msgs, me)).toBeNull();
    expect(checkQuote(item("t1", "Can you confirm 40 board feet?", "b"), "decision", msgs, me)).toBeNull();
  });
  it("drops promises put in the wrong mouth", () => {
    expect(checkQuote(item("t1", "I will send the invoice Friday", "b"), "i_owe", msgs, me)).toBe("wrong_speaker");
    expect(checkQuote(item("t1", "I'll call you Monday", "a"), "owed_to_me", msgs, me)).toBe("wrong_speaker");
    expect(checkQuote(item("t1", "about the trim order", "a"), "decision", msgs, me)).toBe("wrong_speaker");
  });
  it("drops quotes from another thread, unknown messages, invented text and fragments", () => {
    expect(checkQuote(item("t1", "Thursday works for me", "c"), "i_owe", msgs, me)).toBe("wrong_thread");
    expect(checkQuote(item("t1", "I'll call you Monday", "zzz"), "i_owe", msgs, me)).toBe("quote_not_found");
    expect(checkQuote(item("t1", "I'll call you Tuesday", "a"), "i_owe", msgs, me)).toBe("quote_not_found");
    expect(checkQuote(item("t1", "Monday", "a"), "i_owe", msgs, me)).toBe("quote_too_short");
    expect(checkQuote(item("t1", "  call  ", "a"), "i_owe", msgs, me)).toBe("quote_too_short");
    expect(checkQuote(item("t1", "I'll call you ... trim order", "a"), "i_owe", msgs, me)).toBe("quote_not_found");
  });
  it("reads the address from a From header", () => {
    expect(emailOf("Dave Lee <DAVE@example.com>")).toBe("dave@example.com");
    expect(emailOf(" maria@example.com ")).toBe("maria@example.com");
    expect(emailOf('"Lee, Dave" <d@x.com>')).toBe("d@x.com");
  });
});
