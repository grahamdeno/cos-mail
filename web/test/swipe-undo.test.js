import test from "node:test";
import assert from "node:assert/strict";
import { createSwipe, passedPull } from "../public/js/swipe.js";
import { createUndo } from "../public/js/undo.js";
import { saveToGmail } from "../public/js/flow.js";
import { fakeTimers } from "./helpers.js";

function swipeRun(startX, endX) {
  const seen = { decided: null, cancelled: 0, tapped: 0 };
  const s = createSwipe({ onDecide: (d) => (seen.decided = d), onCancel: () => seen.cancelled++, onTap: () => seen.tapped++ });
  s.down(startX); s.move(endX); s.up();
  return seen;
}

test("swipe: past 90 px decides, exactly 90 or less does not", () => {
  assert.equal(swipeRun(200, 291).decided, "right");
  assert.equal(swipeRun(200, 109).decided, "left");
  const at90 = swipeRun(200, 290);
  assert.equal(at90.decided, null);
  assert.equal(at90.cancelled, 1);
  assert.equal(swipeRun(200, 110).decided, null);
});

test("swipe: a small movement is a tap, a half swipe cancels", () => {
  const tap = swipeRun(200, 204);
  assert.equal(tap.tapped, 1);
  assert.equal(tap.decided, null);
  const half = swipeRun(200, 250);
  assert.equal(half.cancelled, 1);
  assert.equal(half.tapped, 0);
});

test("swipe: pointercancel cancels and a stray move does nothing", () => {
  const seen = { c: 0, d: null };
  const s = createSwipe({ onDecide: (d) => (seen.d = d), onCancel: () => seen.c++ });
  s.move(500); s.up();
  assert.equal(seen.d, null);
  s.down(100); s.move(300); s.cancel();
  assert.equal(seen.c, 1);
  s.up();
  assert.equal(seen.d, null);
});

test("pull gestures", () => {
  assert.ok(passedPull(400, 330, "up"));
  assert.ok(!passedPull(400, 380, "up"));
  assert.ok(passedPull(100, 170, "down"));
});

test("undo: the action commits only after the full 5 seconds", () => {
  const clock = fakeTimers();
  const log = [];
  const u = createUndo({ ms: 5000, setT: clock.setT, clearT: clock.clearT });
  u.start({ label: "x", commit: () => log.push("commit"), revert: () => log.push("revert") });
  clock.advance(4999);
  assert.deepEqual(log, []);
  clock.advance(1);
  assert.deepEqual(log, ["commit"]);
  assert.equal(u.active, false);
});

test("undo inside the window reverts and never commits", () => {
  const clock = fakeTimers();
  const log = [];
  const u = createUndo({ setT: clock.setT, clearT: clock.clearT });
  u.start({ label: "x", commit: () => log.push("commit"), revert: () => log.push("revert") });
  clock.advance(3000);
  assert.equal(u.undo(), true);
  clock.advance(10_000);
  assert.deepEqual(log, ["revert"]);
  assert.equal(u.undo(), false);
});

test("undo: a new action commits the one before it; only the latest can be undone", () => {
  const clock = fakeTimers();
  const log = [];
  const u = createUndo({ setT: clock.setT, clearT: clock.clearT });
  u.start({ label: "a", commit: () => log.push("commit a"), revert: () => log.push("revert a") });
  clock.advance(1000);
  u.start({ label: "b", commit: () => log.push("commit b"), revert: () => log.push("revert b") });
  assert.deepEqual(log, ["commit a"]);
  u.undo();
  assert.deepEqual(log, ["commit a", "revert b"]);
});

test("undo: leaving the page inside the window cancels instead of committing", () => {
  const clock = fakeTimers();
  const log = [];
  const u = createUndo({ setT: clock.setT, clearT: clock.clearT });
  u.start({ label: "x", commit: () => log.push("commit"), revert: () => log.push("revert") });
  u.cancel();
  clock.advance(10_000);
  assert.deepEqual(log, ["revert"]);
});

test("the Gmail draft is created only after the undo window closes", async () => {
  const clock = fakeTimers();
  const gmailCalls = [];
  const gmail = { createDraft: async (p) => { gmailCalls.push(p); return "d1"; }, updateDraft: async () => "d1" };
  const draft = { subject: "Re: Install", meta: { to: "dana@example.com", threadId: "t1", inReplyTo: "<a@b>", references: "<a@b>" } };
  const u = createUndo({ setT: clock.setT, clearT: clock.clearT });
  u.start({ label: "Drafting", commit: () => saveToGmail({ gmail, draft, body: "Monday works." }), revert: () => {} });
  clock.advance(4999);
  assert.equal(gmailCalls.length, 0, "nothing in Gmail while the window is open");
  clock.advance(1);
  await new Promise((r) => setImmediate(r));
  assert.equal(gmailCalls.length, 1);
  assert.equal(gmailCalls[0].threadId, "t1");

  // And an undone swipe never reaches Gmail.
  u.start({ label: "Drafting", commit: () => saveToGmail({ gmail, draft, body: "x" }), revert: () => {} });
  u.undo();
  clock.advance(10_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(gmailCalls.length, 1);
});
