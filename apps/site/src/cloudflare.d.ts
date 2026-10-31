// The Worker bindings from wrangler.jsonc, and the secret from `wrangler secret put` or .dev.vars.
declare module "cloudflare:workers" {
  export const env: {
    WAITLIST_DB: import("./waitlist/join.ts").WaitlistDb;
    SIGNUP_LIMIT: import("./waitlist/join.ts").Limiter;
    TURNSTILE_SECRET_KEY?: string;
  };
}
