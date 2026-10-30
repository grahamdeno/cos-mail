import test from "node:test";
import assert from "node:assert/strict";
import { normalize, quoteInBody } from "../public/js/quote.js";
import { dayKey, addDays, daysBetween } from "../public/js/day.js";
import { editRatio } from "../public/js/words.js";
import { normalize as workerNormalize, quoteInBody as workerQuoteInBody } from "../../worker/src/quote.ts";
import { dayKey as workerDayKey } from "../../worker/src/day.ts";

const corpus = [
  "I’ll send the revised quote by Monday.",
  "He said “soft-close hinges” — by Friday…",
  "Line one\n\n   line   two\t\tthree",
  "zero​width﻿ chars",
  "UPPER and lower – en dash − minus ‒ figure",
  "",
  "   ",
  "It's fine ′prime′ and ″double″",
];

test("page quote normalization matches the Worker's on a corpus", () => {
  for (const s of corpus) assert.equal(normalize(s), workerNormalize(s), JSON.stringify(s));
});

test("quoteInBody matches the Worker's", () => {
  const body = "Hi Dana,\n\nI’ll call you Monday about the trim order — promise.\nMaria";
  const quotes = ["I'll call you monday about the trim order - promise", "call you Tuesday", "", "TRIM ORDER"];
  for (const q of quotes) assert.equal(quoteInBody(q, body), workerQuoteInBody(q, body), q);
  assert.equal(quoteInBody("x", undefined), false);
  assert.equal(quoteInBody("anything", null), false);
});

test("typographic quotes and dashes do not drop a real promise", () => {
  assert.ok(quoteInBody("I'll send it - promise", "I’ll send it — promise"));
});

test("day key matches the Worker, including around 4 AM and DST changes", () => {
  const instants = [
    "2026-10-30T07:59:59Z", "2026-10-30T08:00:00Z", // 3:59:59 and 4:00:00 Eastern (EDT)
    "2026-11-01T05:30:00Z", "2026-11-01T08:59:59Z", "2026-11-01T09:00:00Z", // fall back at 2 AM
    "2026-03-08T06:30:00Z", "2026-03-08T08:30:00Z", "2026-03-08T09:00:00Z", // spring forward
    "2026-12-31T23:59:59Z", "2027-01-01T08:59:59Z", "2027-01-01T09:00:00Z",
  ];
  for (const iso of instants) {
    const ms = Date.parse(iso);
    assert.equal(dayKey(ms, "America/New_York", 4), workerDayKey(ms, "America/New_York", 4), iso);
  }
  assert.equal(dayKey(Date.parse("2026-10-30T07:59:59Z"), "America/New_York", 4), "2026-10-29");
  assert.equal(dayKey(Date.parse("2026-10-30T08:00:00Z"), "America/New_York", 4), "2026-10-30");
});

test("addDays and daysBetween", () => {
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(daysBetween("2026-10-15", "2026-10-30"), 15);
});

test("edit ratio is the share of words changed", () => {
  assert.equal(editRatio("a b c d", "a b c d"), 0);
  assert.equal(editRatio("a b c d", "a b c e"), 0.25);
  assert.equal(editRatio("a b", "x y z w"), 1);
  assert.equal(editRatio("", ""), 0);
  assert.equal(editRatio("one two three", "one three"), 1 / 3);
  assert.ok(editRatio("a", "b c d e") <= 1);
});
