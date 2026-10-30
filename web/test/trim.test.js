import test from "node:test";
import assert from "node:assert/strict";
import { stripQuoted, trimBody, htmlToText } from "../public/js/trim.js";

test("quoted reply lines are removed", () => {
  const t = "Sounds good, Monday works.\n\n> Can you do Monday?\n> Thanks\n";
  assert.equal(stripQuoted(t), "Sounds good, Monday works.");
});

test("'On ... wrote:' and everything after it is removed, including a wrapped header", () => {
  const one = "Yes.\n\nOn Tue, Oct 27, 2026 at 3:04 PM Dana Lee <dana@example.com> wrote:\n> old\n";
  assert.equal(stripQuoted(one), "Yes.");
  const wrapped = "Yes.\n\nOn Tue, Oct 27, 2026 at 3:04 PM Dana Lee <dana.lee@example.com>\nwrote:\n> old text\n";
  assert.equal(stripQuoted(wrapped), "Yes.");
});

test("a sentence that starts with 'On' but is not a quote header stays", () => {
  assert.equal(stripQuoted("On Monday I will call you."), "On Monday I will call you.");
});

test("Outlook header blocks and original-message dividers are removed", () => {
  const outlook = "Thanks.\n\nFrom: Dana Lee <dana@example.com>\nSent: Tuesday, October 27, 2026 3:04 PM\nTo: Maria\nSubject: Install\n\nold body";
  assert.equal(stripQuoted(outlook), "Thanks.");
  assert.equal(stripQuoted("Done.\n-----Original Message-----\nFrom: x"), "Done.");
  assert.equal(stripQuoted("Done.\n________________________________\nFrom: x"), "Done.");
});

test("a lone 'From:' line in the middle of real text stays", () => {
  assert.equal(stripQuoted("Notes\nFrom: the field, nothing new.\nBye"), "Notes\nFrom: the field, nothing new.\nBye");
});

test("signatures and mobile footers are removed", () => {
  assert.equal(stripQuoted("See you then.\n-- \nMaria Ruiz\nOwner"), "See you then.");
  assert.equal(stripQuoted("See you then.\n\nSent from my iPhone"), "See you then.");
  assert.equal(stripQuoted("Ok\nGet Outlook for iOS"), "Ok");
});

test("the cap is 1,500 characters and never ends on half a surrogate pair", () => {
  const long = "word ".repeat(1000);
  assert.equal(trimBody(long).length <= 1500, true);
  const emoji = "a".repeat(1499) + "😀😀";
  const out = trimBody(emoji);
  assert.ok(out.length <= 1500);
  assert.ok(!/[\ud800-\udbff]$/.test(out));
});

test("an all-quoted message trims to empty", () => {
  assert.equal(trimBody("> a\n> b"), "");
});

test("HTML mail becomes plain text, quotes removed, entities decoded", () => {
  const html = '<div>Hi&nbsp;Dana,<br>I&#39;ll call Monday &amp; confirm.</div><div class="gmail_quote"><blockquote>old</blockquote></div>';
  assert.equal(htmlToText(html), "Hi Dana,\nI'll call Monday & confirm.");
  assert.equal(htmlToText("<style>p{}</style><script>x()</script><p>One</p><p>Two</p>"), "One\nTwo");
  assert.equal(htmlToText("<p>bad &#99999999999; ref</p>"), "bad &#99999999999; ref");
});
