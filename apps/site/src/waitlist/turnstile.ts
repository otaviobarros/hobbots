const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Asks Cloudflare whether a Turnstile token is valid. Fails closed: a missing secret, a network
 * error or an unexpected answer counts as not verified.
 */
export const verifyTurnstile = async (
  fetcher: typeof fetch,
  secret: string | undefined,
  token: string,
  ip: string | undefined,
): Promise<boolean> => {
  if (!secret || !token) return false;
  const body = new FormData();
  body.set("secret", secret);
  body.set("response", token);
  if (ip) body.set("remoteip", ip);
  try {
    const response = await fetcher(SITEVERIFY, { method: "POST", body });
    if (!response.ok) return false;
    const result: unknown = await response.json();
    return typeof result === "object" && result !== null && "success" in result && result.success === true;
  } catch {
    return false;
  }
};
