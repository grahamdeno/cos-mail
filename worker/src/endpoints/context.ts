import type { Meter } from "../claude";
import type { Env, Tester } from "../env";
import type { CapContext, Counter, Mode } from "../limits";

export interface Ctx {
  env: Env;
  tester: Tester;
  body: unknown;
  meter: Meter;
  nowMs: number;
  /** Count this call against the daily cap; throws 429 when over. Call after validation. */
  charge: (counter: Counter, mode: Mode) => Promise<CapContext>;
}

export type Handler = (ctx: Ctx) => Promise<unknown>;
