// App shell: state, actions and the screen switch. All the real work is in flow.js, gmail.js and api.js.
import { ApiError, createApi } from "./api.js";
import { createAuth, loadGis } from "./auth.js";
import { CONFIG } from "./config.js";
import { addDays } from "./day.js";
import { clear, h } from "./dom.js";
import { composeDraft, flushLabels, hashStr, pickBrief, runPipeline, saveToGmail, tally, todayKey } from "./flow.js";
import { GmailAuthError, createGmail } from "./gmail.js";
import { briefScreen, connectScreen, doneScreen, draftScreen, handledScreen, loadingScreen, revealScreen } from "./screens.js";
import { createStore, idbAdapter, memoryAdapter } from "./store.js";
import { createUndo } from "./undo.js";
import { editRatio } from "./words.js";

const root = document.getElementById("app");
const bar = document.getElementById("undo");
const barText = document.getElementById("undo-t");

const auth = createAuth();
const api = createApi({ getIdToken: () => auth.getIdToken() });
const gmail = createGmail({ getToken: () => auth.getAccessToken() });
let store = createStore(memoryAdapter());

const undo = createUndo({
  onChange: (label) => { bar.hidden = !label; barText.textContent = label ?? ""; },
});
document.getElementById("undo-b").addEventListener("click", () => undo.undo());
// Leaving the page inside the undo window cancels the action. Nothing is written to Gmail.
addEventListener("pagehide", () => undo.cancel());
document.addEventListener("visibilitychange", () => { if (document.hidden) undo.cancel(); });

/** @type {any} */
const s = {
  screen: "connect",
  user: null,
  error: null,
  gisReady: false,
  backfillDone: false,
  today: todayKey(),
  loading: { kicker: "", title: "", detail: "", count: "" },
  reveal: { mine: [], theirs: [], scanned: 0 },
  deck: [],
  deckTotal: 0,
  drafting: 0,
  draftsToday: 0,
  handled: [],
  handledIndex: {},
  handledCount: 0,
  tally: { unchangedWeek: 0, savedWeek: 0, openMine: 0, openTheirs: 0, unchangedTotal: 0, toLevel3: CONFIG.unchangedForLevel3 },
  draft: null,
  briefStartMs: 0,
  elapsed: null,
  pulse: false,
  openedAnswered: false,
};

const friendly = (e) =>
  e instanceof GmailAuthError || e instanceof ApiError ? e.message : e?.message || "Something went wrong. Try again.";

function render() {
  const view = {
    connect: connectScreen,
    loading: loadingScreen,
    reveal: revealScreen,
    brief: briefScreen,
    done: doneScreen,
    handled: handledScreen,
    draft: draftScreen,
  }[s.screen];
  const el = view(s, actions);
  clear(root);
  root.append(el);
  el.mount?.();
  window.scrollTo(0, 0);
}

const needAccess = () => {
  if (auth.hasAccess()) return false;
  s.error = new GmailAuthError().message;
  s.screen = "connect";
  render();
  return true;
};

// ---------- actions ----------
const actions = {
  mountGoogleButton(el) {
    if (s.gisReady && el) auth.renderButton(el);
  },

  async getBrief() {
    s.error = null;
    s.today = todayKey();
    try {
      await auth.requestAccess();
      const mail = await gmail.getProfileEmail();
      if (mail !== auth.profile.email) throw new Error(`This Gmail account (${mail}) is not the one you signed in with (${auth.profile.email}). Sign out and use the same account.`);
    } catch (e) {
      s.error = friendly(e);
      return render();
    }
    const mode = s.backfillDone ? "daily" : "backfill";
    const cutoffMs = mode === "daily" ? await store.getMeta("lastBriefMs", Date.now() - 86_400_000) : 0;
    s.screen = "loading";
    s.loading = { kicker: mode === "backfill" ? "First look" : weekdayName(), title: "Finding your mail", detail: "Your mail is read on this phone and sent to the assistant without being kept.", count: "" };
    render();
    try {
      const r = await runPipeline({
        mode, cutoffMs, gmail, api, store, me: auth.profile,
        onStep: (st) => {
          const L = s.loading;
          if (st.step === "read") { L.title = "Reading your threads"; L.count = st.total ? `${st.done ?? 0} of ${st.total}` : ""; }
          if (st.step === "sort") { L.title = "Sorting what needs you"; L.count = st.total ? `${Math.min(st.done + CONFIG.sortPerCall, st.total)} of ${st.total}` : ""; }
          if (st.step === "extract") { L.title = "Finding promises and questions"; L.count = ""; }
          render();
        },
      });
      s.backfillDone = true;
      s.handledCount = r.handled.length;
      if (r.limit) s.error = r.limit.message;
      else if (r.partial) s.error = "Some mail could not be read this time. It will be picked up tomorrow.";
      if (mode === "backfill") await showReveal(r.scanned);
      else await actions.startBrief();
    } catch (e) {
      s.error = friendly(e);
      s.screen = "connect";
      render();
    }
    flushLabels({ store, api }).catch(() => {});
  },

  async startBrief() {
    const decs = await store.listDecisions();
    s.today = todayKey();
    s.deck = pickBrief(decs, s.today);
    s.deckTotal = s.deck.length;
    s.handled = await store.listHandled();
    s.handledCount = s.handled.length;
    s.draftsToday = (await store.getMeta(`drafts:${s.today}`, 0)) || 0;
    s.briefStartMs = s.briefStartMs || Date.now();
    if (s.deck.length) { s.screen = "brief"; render(); } else await finishBrief();
  },

  decide(dir, item) {
    if (dir === "right" && needAccess()) return;
    s.error = null;
    s.deck = s.deck.filter((d) => d.id !== item.id);
    const first = (item.person || "them").split(" ")[0];
    const label = dir === "right" ? `Drafting: ${item.recommended.answer.slice(0, 28)} to ${first}` : "Not now: back tomorrow";
    undo.start({
      label,
      commit: () => commitDecision(dir, item),
      revert: () => { s.deck.unshift(item); s.screen = "brief"; render(); },
    });
    if (s.deck.length) render(); else finishBrief();
  },

  async openDraft(item, kind, text) {
    if (needAccess()) return;
    undo.flush();
    s.error = null;
    s.draft = { item, kind, status: "writing", toName: item.person, subject: "", text: "", original: "", blanks: [], note: "", dr: null, savedId: null, saved: false, savedText: "", busy: false, error: null };
    s.screen = "draft";
    render();
    await generate({ kind, text: kind === "own_words" ? text : item.recommended.answer }, false);
  },

  draftInput(v) { s.draft.text = v; if (s.draft.saved) s.draft.saved = false; },

  async shorter() {
    const d = s.draft;
    d.status = "writing";
    render();
    await generate({ kind: d.kind, text: d.kind === "own_words" ? d.ownText ?? d.item.recommended.answer : d.item.recommended.answer }, true);
  },

  async saveDraft() {
    const d = s.draft;
    d.busy = true;
    render();
    try {
      d.savedId = await saveToGmail({ gmail, draft: d.dr, body: d.text, existingId: d.savedId });
      d.saved = true;
      d.savedText = d.text;
      if (!d.countedOnce) {
        d.countedOnce = true;
        await bumpDrafts();
        s.deck = s.deck.filter((x) => x.id !== d.item.id);
        await store.patchDecision(d.item.id, { status: "drafted", decidedAt: new Date().toISOString() });
      }
    } catch (e) {
      d.error = friendly(e);
      d.status = "error";
    }
    d.busy = false;
    render();
  },

  async closeDraft() {
    const d = s.draft;
    if (d?.savedId) {
      const ratio = editRatio(d.original, d.savedText);
      await store.addLabel({ type: ratio === 0 ? "draft_unchanged" : "draft_edited", thread_id: d.item.thread_id, ratio, day: s.today });
      if (ratio === 0) await store.setMeta("unchangedTotal", ((await store.getMeta("unchangedTotal", 0)) || 0) + 1);
    }
    s.draft = null;
    if (s.deck.length) { s.screen = "brief"; render(); } else await finishBrief();
  },

  notAPromise(item) {
    s.reveal.mine = s.reveal.mine.filter((x) => x.id !== item.id);
    undo.start({
      label: "Not a promise: removed",
      commit: async () => {
        await store.setLedgerStatus(item.id, "dismissed");
        await store.addLabel({ type: "not_a_promise", thread_id: item.thread_id, day: s.today });
      },
      revert: () => { s.reveal.mine.unshift(item); if (s.screen === "reveal") render(); },
    });
    render();
  },

  openHandled() { s.screen = "handled"; render(); },
  async closeHandled() { s.screen = "done"; render(); },
  nextHandled(g) { s.handledIndex[g] = (s.handledIndex[g] ?? 0) + 1; render(); },

  async neededMe(it) {
    const d = {
      id: `${it.thread_id}:${hashStr(`flag${it.id}`)}`,
      thread_id: it.thread_id, person: it.from, question: `${it.from}: ${it.subject || "this message"}`, quote: "", quote_message_id: it.id,
      recommended: { answer: "Reply", reason: "You said this one needed you." }, alternate: "Not now", deadline: null, rank: 1,
      source: "flagged", status: "pending", firstSeenDay: s.today, deferUntil: addDays(s.today, 1), deferrals: 0, decidedAt: null,
    };
    await store.upsertDecisions([d]);
    await store.addLabel({ type: "needed_me", thread_id: it.thread_id, day: s.today });
    await store.removeHandled(it.id);
    s.handled = s.handled.filter((x) => x.id !== it.id);
    s.handledCount = s.handled.length;
    render();
  },

  async openedGmail(yes) {
    await store.addLabel({ type: yes ? "opened_gmail_yes" : "opened_gmail_no", day: s.today });
    await store.setMeta("openedAnsweredDay", s.today);
    s.openedAnswered = true;
    render();
  },

  async signOut() {
    undo.cancel();
    auth.signOut();
    await store.clearAll();
    Object.assign(s, { user: null, screen: "connect", error: null, backfillDone: false, deck: [], deckTotal: 0, draft: null, handled: [], handledCount: 0, draftsToday: 0, briefStartMs: 0, elapsed: null });
    render();
  },
};

// ---------- helpers ----------
const weekdayName = () => new Date().toLocaleDateString("en-US", { weekday: "long", timeZone: CONFIG.dayTz });

async function showReveal(scanned) {
  const ledger = (await store.listLedger()).filter((c) => c.status === "open" || c.status === "possibly_done");
  const mine = ledger
    .filter((c) => c.direction === "i_owe" && c.status === "open")
    .sort((a, b) => ((a.due ?? "9999") < (b.due ?? "9999") ? -1 : 1));
  s.reveal = { mine, theirs: ledger.filter((c) => c.direction === "owed_to_me" && c.status === "open"), scanned };
  s.screen = "reveal";
  render();
}

async function generate({ kind, text }, shorter) {
  const d = s.draft;
  d.ownText = kind === "own_words" ? text : d.ownText;
  try {
    const out = await composeDraft({ gmail, api, me: auth.profile, decision: d.item, answer: { kind, text }, shorter });
    d.dr = out;
    d.subject = out.subject;
    d.text = out.body;
    d.original = out.body;
    d.blanks = out.blanks;
    d.toName = out.meta.toName || d.item.person;
    d.note = `Written from your ${kind === "own_words" ? "words" : "answer"}. Tone matched to your recent emails to ${(d.toName || "them").split(" ")[0]}.`;
    d.status = "ready";
    d.error = null;
  } catch (e) {
    d.status = "error";
    d.error = friendly(e);
  }
  if (s.screen === "draft") render();
}

async function commitDecision(dir, item) {
  if (dir === "left") {
    await store.patchDecision(item.id, { deferUntil: addDays(s.today, 1), deferrals: (item.deferrals || 0) + 1 });
    return;
  }
  s.drafting++;
  if (s.screen === "done") render();
  try {
    const out = await composeDraft({ gmail, api, me: auth.profile, decision: item, answer: { kind: "recommended", text: item.recommended.answer } });
    await saveToGmail({ gmail, draft: out, body: out.body });
    await store.patchDecision(item.id, { status: "drafted", decidedAt: new Date().toISOString() });
    await store.addLabel({ type: "draft_unchanged", thread_id: item.thread_id, ratio: 0, day: s.today });
    await store.setMeta("unchangedTotal", ((await store.getMeta("unchangedTotal", 0)) || 0) + 1);
    await bumpDrafts();
    if (out.blanks.length) s.error = `The draft for ${item.person} has blanks to fill in Gmail: ${out.blanks.join(", ")}`;
  } catch (e) {
    s.error = friendly(e);
    s.deck.unshift(item);
    if (s.screen === "done") s.screen = "brief";
  }
  s.drafting--;
  if (s.screen === "brief" || s.screen === "done") render();
}

async function bumpDrafts() {
  s.draftsToday++;
  await store.setMeta(`drafts:${s.today}`, s.draftsToday);
}

async function finishBrief() {
  const secs = s.briefStartMs ? Math.round((Date.now() - s.briefStartMs) / 1000) : 0;
  s.elapsed = secs ? `${Math.floor(secs / 60)} min ${secs % 60} sec` : "";
  s.tally = await tally(store, s.today);
  s.openedAnswered = (await store.getMeta("openedAnsweredDay")) === s.today;
  s.pulse = (await store.getMeta("pulseDay")) !== s.today;
  if (s.pulse) await store.setMeta("pulseDay", s.today);
  s.screen = "done";
  render();
  flushLabels({ store, api }).catch(() => {});
}

// ---------- boot ----------
async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  try {
    const idb = createStore(idbAdapter());
    await idb.getMeta("backfillDone"); // opens the database; throws if storage is blocked
    store = idb;
  } catch {
    store = createStore(memoryAdapter());
  }
  await store.purge();
  s.backfillDone = !!(await store.getMeta("backfillDone"));
  render();
  try {
    await loadGis();
    auth.init(async () => {
      s.user = auth.profile;
      if (s.screen === "connect") {
        // Same day and already briefed: go straight to the decisions or the finish line.
        if ((await store.getMeta("briefDay")) === todayKey() && s.backfillDone) { await actions.startBrief(); return; }
        render();
      }
    });
    s.gisReady = true;
    render();
    auth.prompt();
  } catch (e) {
    s.error = friendly(e);
    render();
  }
}

boot();
