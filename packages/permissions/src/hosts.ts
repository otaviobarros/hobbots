/**
 * Network hosts as the sandbox proxy reports them (ADR 014). Loopback (the hub's own API
 * included), link-local and cloud metadata addresses are never reachable from the sandbox.
 */

/**
 * The host in the form a URL parser gives it: lowercase, without port or trailing dot, numeric
 * IPv4 spellings such as `2130706433` or `0x7f.1` turned into dotted form and IPv6 in brackets.
 * Returns null for something that is not a host.
 */
export const normalizeHost = (raw: string): string | null => {
  let host = raw.trim();
  if (host.length === 0) return null;
  // A bare IPv6 address has more than one colon; a host with a port has one.
  if (!host.startsWith("[") && host.split(":").length > 2) host = `[${host}]`;
  try {
    const { hostname } = new URL(`http://${host}/`);
    if (hostname.length === 0) return null;
    return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  } catch {
    return null;
  }
};

const METADATA_NAMES = new Set(["metadata.google.internal", "metadata.goog"]);

const parseIpv4 = (host: string): ReadonlyArray<number> | null => {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
};

const blockedIpv4 = ([a, b, c, d]: ReadonlyArray<number>): boolean =>
  a === 127 || // loopback
  a === 0 || // "this network", which reaches the hub itself
  (a === 169 && b === 254) || // link-local, including 169.254.169.254 metadata
  (a === 100 && b === 100 && c === 100 && d === 200); // Alibaba Cloud metadata

/** Expands an IPv6 address (without brackets) into its eight 16-bit groups. */
const parseIpv6 = (address: string): ReadonlyArray<number> | null => {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string | undefined): Array<number> | null => {
    if (half === undefined || half === "") return [];
    const out: Array<number> = [];
    for (const part of half.split(":")) {
      const v4 = parseIpv4(part);
      if (v4 !== null) {
        out.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
      } else if (/^[0-9a-f]{1,4}$/.test(part)) {
        out.push(Number.parseInt(part, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  return fill < 1 ? null : [...head, ...Array<number>(fill).fill(0), ...tail];
};

const blockedIpv6 = (groups: ReadonlyArray<number>): boolean => {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeroPrefix && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true; // :: and ::1
  if (zeroPrefix && g5 === 0xffff) return blockedIpv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]); // IPv4-mapped
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local
  // AWS metadata, fd00:ec2::254
  return g0 === 0xfd00 && g1 === 0x0ec2 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 0x254;
};

/** Whether a normalized host or a resolved address is one the sandbox may never reach. */
export const isBlockedHost = (host: string): boolean => {
  if (host === "localhost" || host.endsWith(".localhost") || METADATA_NAMES.has(host)) return true;
  if (host.startsWith("[") && host.endsWith("]")) {
    const groups = parseIpv6(host.slice(1, -1));
    // An address the parser accepted but this check cannot read is refused rather than trusted.
    return groups === null || blockedIpv6(groups);
  }
  const v4 = parseIpv4(host);
  return v4 !== null && blockedIpv4(v4);
};
