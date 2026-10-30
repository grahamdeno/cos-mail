import { describe, expect, it } from "vitest";
import { normalize, quoteInBody } from "../src/quote";

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
