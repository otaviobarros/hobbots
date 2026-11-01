/**
 * Secrets in what Hobbots stores and shows (see the permissions contract). Tool input and output
 * pass through here before they are journaled, stored or sent to a client, so a token a command
 * prints never reaches the database, the event journal or a screen. The runtime's own session is
 * left as it is: this covers Hobbots' copy only.
 */

/** A secret whose exact value the hub knows, and what to call it in place of the value. */
export interface KnownSecret {
  readonly value: string;
  /** What the value was, such as `ANTHROPIC_API_KEY` or `Claude sign-in`. Never the value itself. */
  readonly kind: string;
}

/** What replaces a secret: it says what kind of value was there, never the value. */
export const redactionMarker = (kind: string) => `[redacted: ${kind}]`;

/**
 * Environment variable names that hold credentials, such as `GH_TOKEN`, `PGPASSWORD` or
 * `ANTHROPIC_API_KEY`. `KEY` and `AUTH` count only as whole parts of the name, so `GIT_AUTHOR_NAME`
 * and `KEYBOARD_LAYOUT` do not.
 */
const SECRET_ENV_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY|(?:^|_)(?:KEYS?|AUTH)(?:_|$)/;

/**
 * Variables that name where a credential lives rather than hold it, such as `SSH_AUTH_SOCK` or
 * `GOOGLE_APPLICATION_CREDENTIALS_FILE`. Their values are paths that appear in ordinary output.
 */
const LOCATION_ENV_NAME = /_(?:SOCK|SOCKET|PATH|FILE|DIR|HOME)$/;

/**
 * Values too short or too plain to treat as secrets: replacing every `true` or `1` in tool output
 * would hide more than it protects. Any other value counts, whatever character it starts with.
 */
const MIN_KNOWN_LENGTH = 8;
const usableSecret = (value: string) => value.trim().length >= MIN_KNOWN_LENGTH && !/^\d+$/.test(value.trim());

/** The credentials an environment holds: each variable whose name says it holds one. */
export const secretsFromEnv = (env: Readonly<Record<string, string | undefined>>): ReadonlyArray<KnownSecret> =>
  Object.entries(env).flatMap(([name, value]) =>
    value !== undefined && SECRET_ENV_NAME.test(name) && !LOCATION_ENV_NAME.test(name) && usableSecret(value)
      ? [{ value, kind: name }]
      : [],
  );

interface SecretShape {
  readonly kind: string;
  /**
   * Global. With a `secret` group, only that group is replaced and `prefix` before it is kept;
   * otherwise the whole match is replaced.
   */
  readonly pattern: RegExp;
}

/**
 * Secrets recognized by their shape, for values Hobbots does not know. Repetitions that could
 * meet each other are bounded, so a long line of output cannot make a pattern backtrack for long.
 */
const SHAPES: ReadonlyArray<SecretShape> = [
  // A whole private key block. One cut short, as the head of a long output is, is redacted to the end.
  {
    kind: "private key",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|[\s\S]*$)/g,
  },
  { kind: "Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "OpenAI key", pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g },
  { kind: "GitLab token", pattern: /\bglpat-[\w-]{20,}/g },
  { kind: "Slack token", pattern: /\bxox[abprs]-[\w-]{10,}/g },
  { kind: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "Google API key", pattern: /\bAIza[\w-]{35}/g },
  { kind: "Stripe key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: "JSON web token", pattern: /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g },
  { kind: "bearer token", pattern: /(?<prefix>\bBearer[ \t]+)(?<secret>[A-Za-z0-9\-._~+/]{8,}=*)/g },
  // A password in a URL, such as `https://user:token@github.com/`.
  {
    kind: "password",
    pattern: /(?<prefix>\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{1,256}:)(?<secret>[^\s@/]{1,256})(?=@)/gi,
  },
  // An environment-style assignment, as `env` or a `.env` file prints it: `GH_TOKEN=…`. A quoted
  // value is taken to its closing quote, spaces and escaped quotes (`\"`) included, or to the end of
  // the line when it has none; an unquoted one to the next space. A value
  // that is a variable, a marker or a plain number, such as `MAX_TOKENS=100000`, is not a secret.
  {
    kind: "credential",
    pattern:
      /(?<prefix>\b[A-Z0-9_]{0,64}(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]{0,64}=)(?<secret>"(?!\d+")(?:[^"\\\n$[]|\\.)(?:[^"\\\n]|\\.){7,}(?:"|(?=\n)|$)|'(?!\d+')[^'\n$[][^'\n]{7,}(?:'|(?=\n)|$)|(?!\d+(?:\s|$))[^\s"'$[][^\s"']{7,})/g,
  },
];

const MARKER = /\[redacted: [^\]]+\]/;

/** Replaces each match of a shape, or only its `secret` group, with the shape's marker. */
const replaceShape = (text: string, shape: SecretShape) =>
  text.replace(shape.pattern, (match: string, ...rest: Array<unknown>) => {
    const groups = rest.at(-1) as Record<string, string | undefined> | undefined;
    const secret = typeof groups === "object" ? groups?.secret : undefined;
    // An earlier shape or a known value already replaced it.
    if (MARKER.test(secret ?? match)) return match;
    const marker = redactionMarker(shape.kind);
    // By position: the secret's text may also appear earlier in the match, as in `postgres:postgres@`.
    return secret === undefined ? marker : `${groups?.prefix ?? ""}${marker}`;
  });

/** The kind of the first secret shape `text` holds, or null when it holds none. */
export const secretShapeIn = (text: string): string | null =>
  SHAPES.find((shape) => text.search(shape.pattern) !== -1)?.kind ?? null;

/**
 * `text` with every known secret and every secret shape replaced by a marker that says what kind
 * of value was there. Known values go first, longest first, so a value one shape also matches is
 * named by what the hub knows it to be.
 */
export const redactSecrets = (text: string, known: ReadonlyArray<KnownSecret> = []): string => {
  let result = text;
  for (const secret of [...known].sort((a, b) => b.value.length - a.value.length)) {
    if (usableSecret(secret.value)) result = result.replaceAll(secret.value, redactionMarker(secret.kind));
  }
  for (const shape of SHAPES) result = replaceShape(result, shape);
  return result;
};

/** `value` with every string in it redacted, at any depth. Keys and non-string values stay as they are. */
export const redactSecretsIn = <A>(value: A, known: ReadonlyArray<KnownSecret> = []): A => {
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return redactSecrets(item, known);
    if (Array.isArray(item)) return item.map(walk);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)]));
    }
    return item;
  };
  return walk(value) as A;
};
