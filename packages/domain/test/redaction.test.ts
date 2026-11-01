import { describe, expect, it } from "vitest";
import { redactSecrets, redactSecretsIn, secretShapeIn, secretsFromEnv } from "../src/index.ts";

const KEY_BODY = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB";
const PEM = `-----BEGIN OPENSSH PRIVATE KEY-----\n${KEY_BODY}\n-----END OPENSSH PRIVATE KEY-----`;

describe("redactSecrets", () => {
  it("replaces known values with the name of what they were, longest first", () => {
    const known = [
      { value: "abcdefgh", kind: "SHORT_TOKEN" },
      { value: "abcdefgh-ijklmnop", kind: "LONG_TOKEN" },
    ];
    expect(redactSecrets("a abcdefgh-ijklmnop b abcdefgh", known)).toBe(
      "a [redacted: LONG_TOKEN] b [redacted: SHORT_TOKEN]",
    );
  });

  it("ignores known values too short or too plain to be secrets", () => {
    expect(redactSecrets("true 1234 /Users/me/.ssh/id", [{ value: "true", kind: "A" }])).toBe(
      "true 1234 /Users/me/.ssh/id",
    );
    expect(
      redactSecrets("/Users/me/.ssh/agent.sock", [{ value: "/Users/me/.ssh/agent.sock", kind: "SSH_AUTH_SOCK" }]),
    ).toBe("/Users/me/.ssh/agent.sock");
  });

  it("redacts a private key block it does not know, and one cut short", () => {
    expect(redactSecrets(`key:\n${PEM}\ndone`)).toBe("key:\n[redacted: private key]\ndone");
    expect(redactSecrets(`-----BEGIN RSA PRIVATE KEY-----\n${KEY_BODY}`)).toBe("[redacted: private key]");
    // A public key is not a secret.
    expect(redactSecrets("-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----")).toContain("MIIB");
  });

  it("redacts well-known provider keys by their shape", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      [`sk-ant-api03-${"x".repeat(40)}`, "Anthropic key"],
      [`sk-proj-${"Y".repeat(40)}`, "OpenAI key"],
      [`ghp_${"a".repeat(36)}`, "GitHub token"],
      [`github_pat_${"b".repeat(40)}`, "GitHub token"],
      [`glpat-${"c".repeat(20)}`, "GitLab token"],
      [`xoxb-${"1".repeat(12)}`, "Slack token"],
      ["AKIAABCDEFGHIJKLMNOP", "AWS access key"],
      [`AIza${"d".repeat(35)}`, "Google API key"],
      [`sk_live_${"e".repeat(24)}`, "Stripe key"],
      [`npm_${"f".repeat(36)}`, "npm token"],
      [`eyJ${"g".repeat(10)}.eyJ${"h".repeat(10)}.${"i".repeat(10)}`, "JSON web token"],
    ];
    for (const [secret, kind] of cases) {
      expect(redactSecrets(`value ${secret} end`)).toBe(`value [redacted: ${kind}] end`);
      expect(secretShapeIn(secret)).toBe(kind);
    }
  });

  it("keeps the context around a bearer token, a URL password and an assignment", () => {
    expect(redactSecrets("Authorization: Bearer abc.def-123456")).toBe(
      "Authorization: Bearer [redacted: bearer token]",
    );
    expect(redactSecrets("git clone https://me:s3cretpass@example.com/repo.git")).toBe(
      "git clone https://me:[redacted: password]@example.com/repo.git",
    );
    expect(redactSecrets('DATABASE_PASSWORD="correct-horse" API_KEY=$API_KEY')).toBe(
      "DATABASE_PASSWORD=[redacted: credential] API_KEY=$API_KEY",
    );
  });

  it("leaves ordinary text and earlier markers alone", () => {
    const text = "Running pnpm test in /work, token expired, sk-short, Bearer of news";
    expect(redactSecrets(text)).toBe(text);
    const once = redactSecrets(`ghp_${"a".repeat(36)}`);
    expect(redactSecrets(once)).toBe(once);
    expect(secretShapeIn(text)).toBeNull();
  });

  it("stays fast on long lines that almost match", () => {
    const started = performance.now();
    redactSecrets(`${"A".repeat(200_000)} ${"a.".repeat(100_000)} ${"-----BEGIN ".repeat(10_000)}`);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("redactSecretsIn", () => {
  it("redacts every string at any depth and keeps the rest", () => {
    const known = [{ value: "known-secret-value", kind: "HUB_TOKEN" }];
    expect(
      redactSecretsIn({ command: "echo known-secret-value", edits: [{ new_string: PEM }], count: 2, ok: true }, known),
    ).toEqual({
      command: "echo [redacted: HUB_TOKEN]",
      edits: [{ new_string: "[redacted: private key]" }],
      count: 2,
      ok: true,
    });
  });
});

describe("secretsFromEnv", () => {
  it("takes the variables whose names say they hold credentials", () => {
    expect(
      secretsFromEnv({
        ANTHROPIC_API_KEY: "sk-ant-value-123",
        GH_TOKEN: "gh-value-1234",
        HOME: "/Users/me",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        FEATURE_TOKEN: "on",
        UNSET_SECRET: undefined,
      }),
    ).toEqual([
      { value: "sk-ant-value-123", kind: "ANTHROPIC_API_KEY" },
      { value: "gh-value-1234", kind: "GH_TOKEN" },
    ]);
  });
});
