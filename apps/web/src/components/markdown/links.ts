/** The longest path shown after a link's host before it is shortened. */
const MAX_PATH = 32;

/**
 * The address a reply may link to: web addresses only. Anything else, such as `javascript:`,
 * `file:` or a path inside the app, is dropped and its text shows unlinked.
 */
export const safeUrl = (url: string): string => {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : "";
  } catch {
    return "";
  }
};

/**
 * A link's address as shown beside it: the host in full, as the browser will reach it (so a
 * look-alike letter shows as punycode and a `user@` prefix is dropped), then the path, shortened in
 * the middle when long. An `http:` address keeps its scheme, so an unencrypted link stands out.
 */
export const shownUrl = (href: string): string => {
  const url = new URL(href);
  const scheme = url.protocol === "http:" ? "http://" : "";
  const rest = `${url.pathname}${url.search}`.replace(/^\/$/, "");
  const half = Math.floor((MAX_PATH - 1) / 2);
  const path = rest.length <= MAX_PATH ? rest : `${rest.slice(0, half)}…${rest.slice(-half)}`;
  return `${scheme}${url.host}${path}`;
};

/** The host an image would load from, named on the button that loads it. */
export const urlHost = (url: string): string => new URL(url).host;

/**
 * Whether a link's text already says where it goes, as an autolink does. Text that names a scheme
 * must name the same one, so `https://bank.com` linking to `http://bank.com` still shows its address.
 */
export const showsItsUrl = (text: string, href: string): boolean => {
  const said = text.trim().toLowerCase().replace(/\/$/, "");
  const url = href.toLowerCase().replace(/\/$/, "");
  return said === url || (!/^[a-z]+:/.test(said) && `https://${said}` === url);
};
