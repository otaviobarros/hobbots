const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * What a page calls the hub it came from (ADR 021): the first label of its MagicDNS name, such as
 * `hub` for `hub.example.ts.net`, or null on loopback or a bare address, where no name says more
 * than "the hub". A revoked device can no longer ask the hub, so the name comes from the page.
 */
export const hubNameOf = (hostname: string): string | null => {
  const host = hostname.toLowerCase();
  if (host === "" || LOOPBACK.has(host) || host.includes(":") || host.startsWith("[")) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  return host.split(".")[0] ?? null;
};

/** Whether the page came from the hub's own computer, where pausing remote access changes nothing. */
export const isLoopbackHost = (hostname: string): boolean => LOOPBACK.has(hostname.toLowerCase());
