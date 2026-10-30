export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "bad_origin"
  | "not_on_list"
  | "not_found"
  | "method_not_allowed"
  | "too_large"
  | "daily_limit"
  | "backfill_used"
  | "model_error"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  bad_origin: 403,
  not_on_list: 403,
  not_found: 404,
  method_not_allowed: 405,
  too_large: 413,
  daily_limit: 429,
  backfill_used: 429,
  model_error: 502,
  internal: 500,
};

const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  bad_request: "The request was not in the expected shape. Update the app and try again.",
  unauthorized: "Your sign-in has expired or is missing. Sign in with Google again.",
  bad_origin: "This site is not allowed to use COS Mail. Open the app at cos.tangomike.app.",
  not_on_list: "This Google account is not on the tester list. Ask Graham to add you.",
  not_found: "That address does not exist. Update the app and try again.",
  method_not_allowed: "Only POST is supported here. Update the app and try again.",
  too_large: "That is more mail than one request can carry. Try again with fewer messages.",
  daily_limit: "You've reached today's limit. More tomorrow after 4 AM.",
  backfill_used: "The first-run catch-up has already been used. Your daily brief will pick up from here.",
  model_error: "The assistant could not finish this one. Try again in a minute.",
  internal: "Something went wrong on our side. Try again in a minute.",
};

/** A response-worthy error. Messages are fixed strings and never echo the request. */
export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly field: string | null;
  readonly resetsAt: string | null;

  constructor(code: ErrorCode, opts: { message?: string; field?: string | null; resetsAt?: string | null } = {}) {
    super(opts.message ?? DEFAULT_MESSAGE[code]);
    this.code = code;
    this.status = STATUS[code];
    this.field = opts.field ?? null;
    this.resetsAt = opts.resetsAt ?? null;
  }

  body(): string {
    return JSON.stringify({
      error: { code: this.code, message: this.message, field: this.field, resets_at: this.resetsAt },
    });
  }
}

export const badRequest = (field: string, message?: string) => new HttpError("bad_request", { field, message });
export const tooLarge = (field: string | null, message?: string) => new HttpError("too_large", { field, message });
