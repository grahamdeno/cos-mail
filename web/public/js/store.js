// Local store: ledger items, decisions, labels, handled reasons and small counters.
// Never holds tokens or mail bodies. A guard rejects anything that looks like a credential.
import { CONFIG } from "./config.js";

const STORES = ["ledger", "decisions", "labels", "handled", "meta"];
const KEY_FIELD = { ledger: "id", decisions: "id", labels: "id", handled: "id", meta: "key" };

const SECRET_KEY = /token|secret|authorization|password|credential|bearer/i;
const SECRET_VALUE = [/^ya29\./, /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/, /^1\/\/0[\w-]{20,}/];

/** Throws if a value has a credential-looking key or string. */
export function assertNoSecrets(value, path = "value") {
  if (typeof value === "string") {
    if (SECRET_VALUE.some((re) => re.test(value))) throw new Error(`refusing to store a credential at ${path}`);
    return;
  }
  if (Array.isArray(value)) return value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) throw new Error(`refusing to store a credential field: ${k}`);
      assertNoSecrets(v, `${path}.${k}`);
    }
  }
}

/** In-memory adapter, used by tests and as the fallback when IndexedDB is blocked. */
export function memoryAdapter() {
  const data = Object.fromEntries(STORES.map((s) => [s, new Map()]));
  return {
    async getAll(store) { return [...data[store].values()].map((v) => structuredClone(v)); },
    async get(store, key) { const v = data[store].get(key); return v === undefined ? undefined : structuredClone(v); },
    async put(store, value) { data[store].set(value[KEY_FIELD[store]], structuredClone(value)); },
    async delete(store, key) { data[store].delete(key); },
    async clear(store) { data[store].clear(); },
  };
}

/** IndexedDB adapter. */
export function idbAdapter(name = "cos-mail", factory = globalThis.indexedDB) {
  const dbp = new Promise((resolve, reject) => {
    const req = factory.open(name, 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) req.result.createObjectStore(s, { keyPath: KEY_FIELD[s] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = async (store, mode, fn) => {
    const db = await dbp;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const out = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(out && "result" in out ? out.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  return {
    getAll: (s) => run(s, "readonly", (os) => os.getAll()),
    get: (s, k) => run(s, "readonly", (os) => os.get(k)),
    put: (s, v) => run(s, "readwrite", (os) => os.put(v)),
    delete: (s, k) => run(s, "readwrite", (os) => os.delete(k)),
    clear: (s) => run(s, "readwrite", (os) => os.clear()),
  };
}

const DAY_MS = 86_400_000;

export function createStore(adapter, { now = Date.now } = {}) {
  const put = async (s, v) => { assertNoSecrets(v, s); return adapter.put(s, v); };
  let seq = 0;
  const newId = () => `${now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    // Ledger: promises both ways. Keeps the first status the tester chose.
    async upsertLedger(items) {
      for (const it of items) {
        const old = await adapter.get("ledger", it.id);
        if (old && old.status === "dismissed") continue;
        await put("ledger", old ? { ...old, ...it, firstSeen: old.firstSeen } : it);
      }
    },
    listLedger: () => adapter.getAll("ledger"),
    async setLedgerStatus(id, status) {
      const old = await adapter.get("ledger", id);
      if (!old) return;
      await put("ledger", { ...old, status, doneAt: status === "open" ? null : new Date(now()).toISOString() });
    },

    // Decisions: pending, drafted, dismissed. Keeps status when the same decision is found again.
    async upsertDecisions(items) {
      for (const it of items) {
        const old = await adapter.get("decisions", it.id);
        if (old) { await put("decisions", { ...it, status: old.status, deferUntil: old.deferUntil, deferrals: old.deferrals, firstSeenDay: old.firstSeenDay }); continue; }
        await put("decisions", it);
      }
    },
    listDecisions: () => adapter.getAll("decisions"),
    async patchDecision(id, patch) {
      const old = await adapter.get("decisions", id);
      if (old) await put("decisions", { ...old, ...patch });
    },

    // Labels: type, thread id, day, optional edit ratio. Sent to the Worker as counts, once.
    async addLabel({ type, thread_id = "", ratio = null, day }) {
      const rec = { id: newId(), type, thread_id, day, ratio, sent: false, at: new Date(now()).toISOString() };
      await put("labels", rec);
      return rec;
    },
    listLabels: () => adapter.getAll("labels"),
    async unsentLabels() { return (await adapter.getAll("labels")).filter((l) => !l.sent); },
    async markSent(ids) {
      for (const id of ids) {
        const old = await adapter.get("labels", id);
        if (old) await put("labels", { ...old, sent: true });
      }
    },

    // Handled-without-you reasons (derived by the model, no bodies).
    async replaceHandled(items) { await adapter.clear("handled"); for (const it of items) await put("handled", it); },
    listHandled: () => adapter.getAll("handled"),
    removeHandled: (id) => adapter.delete("handled", id),

    // Small counters and flags.
    async getMeta(key, dflt = null) { const r = await adapter.get("meta", key); return r ? r.value : dflt; },
    setMeta: (key, value) => put("meta", { key, value }),

    /** Drop what is past its keep time: done promises and decisions after 30 days, sent labels after 30 days. */
    async purge() {
      const cutoff = now() - CONFIG.retainDays * DAY_MS;
      const old = (iso) => iso && Date.parse(iso) < cutoff;
      for (const l of await adapter.getAll("ledger")) if (l.status !== "open" && old(l.doneAt)) await adapter.delete("ledger", l.id);
      for (const d of await adapter.getAll("decisions")) if (d.status !== "pending" && old(d.decidedAt)) await adapter.delete("decisions", d.id);
      for (const l of await adapter.getAll("labels")) if (l.sent && old(l.at)) await adapter.delete("labels", l.id);
    },

    async clearAll() { for (const s of STORES) await adapter.clear(s); },
  };
}
