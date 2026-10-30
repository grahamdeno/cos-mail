export interface Env {
  COS_KV: KVNamespace;
  GOOGLE_CLIENT_ID: string;
  OWNER_EMAIL: string;
  ALLOWED_ORIGINS: string;
  MODEL_SORT: string;
  MODEL_EXTRACT: string;
  MODEL_DRAFT: string;
  DAY_TZ: string;
  DAY_START_HOUR: string;
  // Secrets, set with `wrangler secret put`. Never in the repo.
  ANTHROPIC_API_KEY: string;
  EMAIL_HASH_KEY: string;
}

/** Identity taken from a verified Google ID token. */
export interface Tester {
  email: string; // lowercase
  name: string;
  hash: string; // first 16 hex of HMAC-SHA256(EMAIL_HASH_KEY, email)
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}
