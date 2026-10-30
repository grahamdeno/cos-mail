// The six screens, built to the v3 mockups. Each takes the app state `s` and the actions `a` and returns an element.
// Mail-derived text only ever goes in through h(), which uses text nodes.
import { CONFIG } from "./config.js";
import { daysBetween } from "./day.js";
import { h, motionOk } from "./dom.js";
import { createSwipe, passedPull } from "./swipe.js";

const sentence = (t) => (/[.!?]$/.test(t) ? t : `${t}.`);
const plural = (n, one, many) => (n === 1 ? one : many);
const weekday = () => new Date().toLocaleDateString("en-US", { weekday: "long", timeZone: CONFIG.dayTz });

/** Pointer events to a swipe controller. */
function wireSwipe(el, swipe) {
  el.addEventListener("pointerdown", (e) => { if (e.button > 0 || e.target.closest?.("button, a, textarea")) return; swipe.down(e.clientX); el.setPointerCapture?.(e.pointerId); });
  el.addEventListener("pointermove", (e) => swipe.move(e.clientX));
  el.addEventListener("pointerup", () => swipe.up());
  el.addEventListener("pointercancel", () => swipe.cancel());
}

// ---------- 1. Connect (ink) ----------
export function connectScreen(s, a) {
  const first = !s.backfillDone;
  const el = h("main", { class: "screen ink" },
    h("div", { class: "grow" },
      h("h1", { class: "huge xl" }, "Read less email. Miss nothing."),
      h("p", { class: "quiet" }, "It finds the promises and questions in your mail and asks you about them each morning. ", h("b", null, "It never sends anything."), " Your mail is read on this phone and never stored anywhere else."),
    ),
    s.error && h("p", { class: "err", role: "alert" }, s.error),
    s.user
      ? h("button", { class: "solid", type: "button", onclick: a.getBrief }, first ? "Read my last 30 days" : "Get my brief")
      : h("div", { class: "gbtn", id: "gbtn" }),
    s.user
      ? h("p", { class: "hint" }, `Signed in as ${s.user.email}. `, h("button", { class: "linkish", type: "button", onclick: a.signOut }, "Sign out"))
      : h("p", { class: "hint" }, "Beta: Google will say it hasn't verified this app. Tap Advanced, then Go to Chief of Staff Mail."),
    !s.user && h("p", { class: "hint" }, "Google asks you to sign in again about once a week."),
    h("p", { class: "hint" }, h("a", { href: "https://tangomike.app/privacy", target: "_blank", rel: "noopener" }, "Privacy")),
  );
  el.mount = () => { if (!s.user) a.mountGoogleButton(el.querySelector("#gbtn")); };
  return el;
}

// ---------- loading (sky) ----------
export function loadingScreen(s) {
  const l = s.loading;
  return h("main", { class: "screen sky" },
    h("div", { class: "top" }, h("span", null, l.kicker), h("span", { class: "count" }, l.count ?? "")),
    h("div", { class: "grow" }, h("h1", { class: "huge" }, l.title), h("p", { class: "quiet" }, l.detail)),
    s.error && h("p", { class: "err", role: "alert" }, s.error),
  );
}

// ---------- 2. Reveal (sky) ----------
function promiseRow(item, today, a) {
  const late = item.due && item.due < today ? daysBetween(item.due, today) : 0;
  const meta = [item.person];
  if (late) meta.push(h("span", { class: "late" }, `${late} ${plural(late, "day", "days")} late`));
  else if (item.due) meta.push(`due ${item.due}`);
  const over = h("div", { class: "over" },
    h("span", { class: "line" }, `“${item.quote}”`),
    h("span", { class: "meta" }, meta.flatMap((m, i) => (i ? [" · ", m] : [m]))),
    h("button", { class: "linkish", type: "button", onclick: () => a.notAPromise(item) }, "Not a promise"),
  );
  const row = h("div", { class: "peek" }, h("div", { class: "under" }, "Not a", h("br"), "promise"), over);
  const reset = () => { over.classList.add("fly"); over.style.transform = ""; };
  const swipe = createSwipe({
    onMove: (dx) => { over.classList.remove("fly"); over.style.transform = `translateX(${Math.min(0, dx)}px)`; },
    onDecide: (dir) => (dir === "left" ? a.notAPromise(item) : reset()),
    onCancel: reset,
  });
  wireSwipe(row, swipe);
  return row;
}

export function revealScreen(s, a) {
  const n = s.reveal.mine.length;
  const theirs = s.reveal.theirs;
  const names = theirs.slice(0, 2).map((t) => `${t.person}'s ${t.what}`);
  return h("main", { class: "screen sky" },
    h("div", { class: "top" }, h("span", null, `Last ${CONFIG.backfill.days} days`), h("span", { class: "count" }, `${s.reveal.scanned} emails`)),
    h("div", { class: "grow start" },
      n > 0 && h("div", { class: "big-n" }, String(n)),
      h("h1", { class: "huge" }, n > 0 ? `${plural(n, "promise", "promises")} you made and haven't kept.` : "Nothing slipped. Nice."),
      n > 0 && h("div", { class: "rows" }, s.reveal.mine.slice(0, 3).map((it) => h("div", { class: "peekwrap" }, promiseRow(it, s.today, a)))),
      theirs.length > 0 && h("p", { class: "quiet" }, "And ", h("b", null, `${theirs.length} ${plural(theirs.length, "person owes", "people owe")} you`), `: ${names.join(", ")}${theirs.length > 2 ? ", and more" : ""}.`),
    ),
    s.error && h("p", { class: "err", role: "alert" }, s.error),
    h("button", { class: "solid", type: "button", onclick: a.startBrief }, "Start today"),
  );
}

// ---------- 3. Brief (sky) ----------
export function briefScreen(s, a) {
  const item = s.deck[0];
  const total = s.deckTotal;
  const pos = total - s.deck.length + 1;
  const card = h("div", { class: "decision" },
    h("div", { class: "who" }, item.deadline ? `${item.person}, needs it by ${item.deadline}` : item.person),
    h("h1", { class: "huge" }, item.question),
    h("div", { class: "rec" }, h("b", null, sentence(item.recommended.answer)), " ", item.recommended.reason),
  );
  const sr = h("span", { class: "side r" }, "Draft it →");
  const sl = h("span", { class: "side l" }, "← Not now");
  const zone = h("div", { class: "deckzone", tabindex: "0", role: "group", "aria-label": "Decision. Arrow right drafts the answer, arrow left defers, Enter opens the draft." }, sr, sl, card);

  const fly = (dir) => {
    if (!motionOk()) return a.decide(dir, item);
    card.classList.add("fly");
    card.style.transform = `translateX(${dir === "right" ? 340 : -340}px) rotate(${dir === "right" ? 6 : -6}deg)`;
    card.style.opacity = "0";
    setTimeout(() => a.decide(dir, item), 220);
  };
  const reset = () => { card.classList.add("fly"); card.style.transform = ""; sr.style.opacity = "0"; sl.style.opacity = "0"; };
  const swipe = createSwipe({
    onMove: (dx) => {
      card.classList.remove("fly");
      card.style.transform = `translateX(${dx}px) rotate(${dx / 30}deg)`;
      sr.style.opacity = dx > 30 ? String(Math.min(1, dx / CONFIG.swipePx)) : "0";
      sl.style.opacity = dx < -30 ? String(Math.min(1, -dx / CONFIG.swipePx)) : "0";
    },
    onDecide: (dir) => fly(dir),
    onCancel: reset,
    onTap: () => a.openDraft(item, "recommended"),
  });
  wireSwipe(zone, swipe);
  zone.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { e.preventDefault(); fly("right"); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); fly("left"); }
    else if (e.key === "Enter") { e.preventDefault(); a.openDraft(item, "recommended"); }
  });

  const words = h("textarea", { "aria-label": "What do you want to say?", placeholder: "What do you want to say?", rows: "3", hidden: true });
  const go = h("button", { class: "act", type: "button", hidden: true, onclick: () => words.value.trim() && a.openDraft(item, "own_words", words.value.trim()) }, "Write it");
  const toggle = h("button", { class: "act quietbtn", type: "button", onclick: () => { words.hidden = !words.hidden; go.hidden = words.hidden; if (!words.hidden) words.focus(); } }, "Say something else");

  const el = h("main", { class: "screen sky" },
    h("div", { class: "top" }, h("span", null, weekday()), h("span", { class: "count" }, `${pos} / ${total}`)),
    zone,
    s.error && h("p", { class: "err", role: "alert" }, s.error),
    h("div", { class: "say" }, toggle, words, go),
    h("p", { class: "hint" }, "Swipe right to draft the answer above.", h("br"), "Swipe left for tomorrow. Tap the question to read the draft first."),
    h("div", { class: "row-actions" },
      h("button", { class: "act quietbtn", type: "button", onclick: () => fly("left") }, "← Not now"),
      h("button", { class: "act", type: "button", onclick: () => fly("right") }, "Draft it →"),
    ),
  );
  el.mount = () => zone.focus({ preventScroll: true });
  return el;
}

// ---------- 4. Done (sky) ----------
export function doneScreen(s, a) {
  const t = s.tally;
  const drafting = s.drafting > 0;
  const n = s.draftsToday;
  const drafts = drafting ? `Writing ${s.drafting} ${plural(s.drafting, "draft", "drafts")}…` : n > 0 ? `${n} ${plural(n, "draft is", "drafts are")} waiting in Gmail. Nothing else needs you today.` : "Nothing else needs you today.";
  let strip = null;
  let y0 = null;
  strip = h("button", { class: "strip", type: "button", onclick: a.openHandled },
    h("div", { class: "grab" }), h("b", null, `${s.handledCount} handled without you`), h("span", null, "Pull up to see why each one didn't need you"));
  strip.addEventListener("pointerdown", (e) => { y0 = e.clientY; strip.setPointerCapture?.(e.pointerId); });
  strip.addEventListener("pointerup", (e) => { if (y0 !== null && passedPull(y0, e.clientY, "up")) { y0 = null; a.openHandled(); } y0 = null; });

  const el = h("main", { class: `screen sky${s.pulse && motionOk() ? " pulse" : ""}` },
    h("div", { class: "top" }, h("span", null, weekday()), h("span", { class: "count" }, s.elapsed ?? "")),
    h("div", { class: "grow" },
      h("h1", { class: "huge xl" }, "Done."),
      h("p", { class: "quiet" }, drafts),
      s.error && h("p", { class: "err", role: "alert" }, s.error),
      h("div", { class: "tally" },
        h("b", null, String(t.unchangedWeek)), h("span", null, `of ${t.savedWeek} ${plural(t.savedWeek, "draft", "drafts")} saved unchanged this week`),
        h("b", null, String(t.openMine)), h("span", null, `${plural(t.openMine, "promise", "promises")} of yours still open`),
      ),
      h("div", { class: "ladder" }, h("span", null, "Reads"), h("span", { class: "now" }, "Drafts"), h("span", null, "Sends"), h("span", null, "Handles")),
      h("p", { class: "quiet" }, t.toLevel3 > 0 ? `${t.toLevel3} more unchanged drafts and it can offer to send for you.` : "You have reached the number where it could offer to send. It still won't."),
      !s.openedAnswered && h("div", { class: "yn" }, "Did you open Gmail on your own today?",
        h("button", { class: "linkish", type: "button", onclick: () => a.openedGmail(true) }, "Yes"),
        h("button", { class: "linkish", type: "button", onclick: () => a.openedGmail(false) }, "No")),
    ),
    h("p", { class: "hint" }, h("button", { class: "linkish", type: "button", onclick: a.signOut }, "Sign out")),
    strip,
  );
  return el;
}

// ---------- 4a. Handled (ink) ----------
const GROUP_LABEL = { receipt: ["receipt or confirmation", "receipts and confirmations"], newsletter: ["newsletter", "newsletters"], fyi: ["just so you know", "just so you know"], answered_by_other: ["someone else answered", "someone else answered"] };
const GROUP_ORDER = ["receipt", "newsletter", "fyi", "answered_by_other"];

export function handledScreen(s, a) {
  const groups = GROUP_ORDER.map((g) => [g, s.handled.filter((x) => x.group === g)]).filter(([, items]) => items.length);
  let y0 = null;
  const el = h("main", { class: "screen ink sheet", "aria-label": "Handled without you" },
    h("div", { class: "top" }, h("b", null, `${s.handled.length} handled without you`), h("span", { class: "count" }, "today")),
    h("div", { class: "rows grow start" },
      groups.length === 0 && h("p", { class: "quiet" }, "Nothing was set aside today."),
      groups.map(([g, items]) => {
        const i = (s.handledIndex[g] ?? 0) % items.length;
        const it = items[i];
        return h("div", null,
          h("span", { class: "line" }, `${items.length} ${GROUP_LABEL[g][items.length === 1 ? 0 : 1]}`),
          h("span", { class: "meta" }, `${it.from}: ${it.reason}`),
          h("span", null,
            h("button", { class: "linkish", type: "button", onclick: () => a.neededMe(it) }, "This needed me"),
            items.length > 1 && h("button", { class: "linkish", type: "button", onclick: () => a.nextHandled(g) }, "  Next one")));
      }),
    ),
    h("p", { class: "hint" }, "Pull down to close"),
    h("button", { class: "act quietbtn", type: "button", onclick: a.closeHandled }, "Close"),
  );
  el.addEventListener("pointerdown", (e) => { y0 = e.clientY; });
  el.addEventListener("pointerup", (e) => { if (y0 !== null && passedPull(y0, e.clientY, "down") && el.scrollTop === 0) a.closeHandled(); y0 = null; });
  return el;
}

// ---------- 3a. Draft (ink) ----------
export function draftScreen(s, a) {
  const d = s.draft;
  const ready = d.status === "ready";
  const area = h("textarea", { "aria-label": "Reply text", hidden: !ready, oninput: (e) => a.draftInput(e.target.value) });
  if (ready) area.value = d.text;
  return h("main", { class: "screen ink" },
    h("div", { class: "top" }, h("span", null, `Reply to ${d.toName || d.item.person}`), h("span", { class: "count" }, d.subject ?? "")),
    h("div", { class: "editor" },
      d.status === "writing" && h("p", { class: "quiet" }, "Writing it in your words…"),
      d.status === "error" && h("p", { class: "err", role: "alert" }, d.error),
      area,
      ready && h("p", { class: "to" }, d.blanks.length ? `Fill in before sending: ${d.blanks.join(", ")}` : d.note),
    ),
    h("div", { class: "row-actions" },
      h("button", { class: "act", type: "button", disabled: !ready || d.busy, onclick: a.saveDraft }, d.saved ? "Saved" : d.busy ? "Saving…" : "Save to Gmail drafts"),
      h("button", { class: "act quietbtn", type: "button", disabled: !ready || d.busy, onclick: a.shorter }, "Shorter"),
    ),
    d.saved && h("p", { class: "saved" }, "Saved. Send it from Gmail when you're ready. ", h("a", { href: "https://mail.google.com/mail/u/0/#drafts", target: "_blank", rel: "noopener" }, "Open Gmail")),
    h("button", { class: "act quietbtn", type: "button", onclick: a.closeDraft }, "Back"),
  );
}
