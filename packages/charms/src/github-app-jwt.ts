import { Clock, Effect, Layer, Redacted } from "effect";
import { Digest, KeyFormat, SecureRandom, Signature } from "effect/crypto";
import { Base64Url } from "effect/encoding";
import { GitHubError } from "./github-error.ts";

/**
 * A JSON Web Token that signs the hub in as a hob's own GitHub App (ADR 022), as GitHub's
 * documentation for generating a JWT for an app describes it: `RS256`, issued by the app's client
 * ID, issued 60 seconds in the past against clock drift, and expiring 9 minutes from now, inside
 * GitHub's limit of 10. The hub makes a new one whenever it needs one and never stores it.
 */

/** GitHub makes 2048-bit RSA keys for apps. The length is not checked when a key is read. */
const RS256 = Signature.rsaPkcs1v15({ hash: Digest.sha256, modulusLength: 2048 });

const ISSUED_BEFORE_S = 60;
const EXPIRES_AFTER_S = 9 * 60;

const keyRefused = new GitHubError({
  reason: "signed-out",
  message: "The hob's GitHub app key the hub keeps cannot be read. Give the hob a new app.",
});

/** Reads the key as GitHub gives it (PKCS#1, `RSA PRIVATE KEY`), or as PKCS#8 (`PRIVATE KEY`). */
const privateKey = (pem: string) =>
  KeyFormat.decodePrivate(
    KeyFormat.pem(pem.includes("BEGIN RSA PRIVATE KEY") ? KeyFormat.pkcs1 : KeyFormat.pkcs8),
    RS256,
    pem,
  );

const segment = (value: unknown) => Base64Url.encode(JSON.stringify(value));

/** A JWT for the app with `clientId`, signed with its private key `pem`. */
export const appJwt = (clientId: string, pem: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const unsigned = `${segment({ alg: "RS256", typ: "JWT" })}.${segment({
      iat: now - ISSUED_BEFORE_S,
      exp: now + EXPIRES_AFTER_S,
      iss: clientId,
    })}`;
    const key = yield* privateKey(Redacted.value(pem));
    const signer = yield* Signature.Signature;
    const signature = yield* signer.sign(key, new TextEncoder().encode(unsigned));
    return Redacted.make(`${unsigned}.${Base64Url.encode(signature)}`);
  }).pipe(
    Effect.catchTag("CryptoError", () => Effect.fail(keyRefused)),
    Effect.provide(Signature.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))),
  );
