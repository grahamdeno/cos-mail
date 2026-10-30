// Undo instead of confirm. An action waits `ms` and then commits. Undo before that reverts it.
// The Gmail draft is created in `commit`, so nothing is written to Gmail while the window is open.
import { CONFIG } from "./config.js";

/** @param {{ms?: number, setT?: (f: () => void, t: number) => any, clearT?: (id: any) => void, onChange?: (label: string | null) => void}} [opts] */
export function createUndo(opts = {}) {
  const { ms = CONFIG.undoMs, setT = (f, t) => setTimeout(f, t), clearT = (id) => clearTimeout(id), onChange = () => {} } = opts;
  /** @type {null | {label: string, commit: () => void, revert: () => void, timer: any}} */
  let pending = null;

  function finish(kind) {
    if (!pending) return false;
    const p = pending;
    pending = null;
    clearT(p.timer);
    onChange(null);
    if (kind === "commit") p.commit();
    else p.revert();
    return true;
  }

  return {
    get label() { return pending ? pending.label : null; },
    get active() { return pending !== null; },
    /** Starting a new action commits the one before it, as in the mockup: only the latest can be undone. */
    start({ label, commit, revert }) {
      finish("commit");
      pending = { label, commit, revert, timer: setT(() => finish("commit"), ms) };
      onChange(label);
    },
    undo() { return finish("revert"); },
    /** The page is going away or hidden: do not commit what the tester has not had time to undo. */
    cancel() { return finish("revert"); },
    /** Commit now (for example when the tester leaves the screen on purpose). */
    flush() { return finish("commit"); },
  };
}
