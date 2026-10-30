import { badRequest, tooLarge } from "./errors";

/** Small schema helpers. Every failure names the first bad field and never echoes its value. */

export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function obj(v: unknown, field: string): Obj {
  if (!isObj(v)) throw badRequest(field);
  return v;
}

export function str(o: Obj, key: string, field: string, opts: { max?: number; nonEmpty?: boolean; limitIs413?: boolean } = {}): string {
  const v = o[key];
  if (typeof v !== "string") throw badRequest(field);
  if (opts.nonEmpty && v.trim() === "") throw badRequest(field);
  if (opts.max !== undefined && v.length > opts.max) {
    throw opts.limitIs413 ? tooLarge(field) : badRequest(field);
  }
  return v;
}

export function optStr(o: Obj, key: string, field: string, opts: { max?: number; limitIs413?: boolean } = {}): string | null {
  if (o[key] === undefined || o[key] === null) return null;
  return str(o, key, field, opts);
}

export function strArray(o: Obj, key: string, field: string, opts: { optional?: boolean; maxItems?: number } = {}): string[] {
  const v = o[key];
  if (v === undefined && opts.optional) return [];
  if (!Array.isArray(v)) throw badRequest(field);
  if (opts.maxItems !== undefined && v.length > opts.maxItems) throw badRequest(field);
  v.forEach((x, i) => {
    if (typeof x !== "string") throw badRequest(`${field}[${i}]`);
  });
  return v as string[];
}

/** Array with 1..max items; over max is 413 (item limit), empty is 400. */
export function arr(o: Obj, key: string, field: string, opts: { min?: number; max: number }): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) throw badRequest(field);
  if (v.length < (opts.min ?? 1)) throw badRequest(field);
  if (v.length > opts.max) throw tooLarge(field);
  return v;
}

export function oneOf<T extends string>(o: Obj, key: string, field: string, values: readonly T[], dflt?: T): T {
  const v = o[key];
  if (v === undefined && dflt !== undefined) return dflt;
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) throw badRequest(field);
  return v as T;
}

export function bool(o: Obj, key: string, field: string, dflt: boolean): boolean {
  const v = o[key];
  if (v === undefined) return dflt;
  if (typeof v !== "boolean") throw badRequest(field);
  return v;
}

export const BODY_MAX = 1500;
export const ID_MAX = 200;
export const SHORT_MAX = 1000;
