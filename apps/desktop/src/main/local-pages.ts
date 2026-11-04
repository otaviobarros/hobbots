import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The local pages (ADR 025): the screens the app shows before this computer is a hub or a connected
 * desktop, from the web client's `local.html` entry. The app serves them from its own resources under
 * a private scheme, so they load with no server running, and they call no API. Electron stays out of
 * this file.
 */
export const LOCAL_SCHEME = "hobbots";
export const LOCAL_ORIGIN = `${LOCAL_SCHEME}://app`;

/** The local pages' entry in the web client's build and on the Vite dev server. */
export const LOCAL_ENTRY = "local.html";

/**
 * Where the built web client is: in the packaged app's resources folder, or the web app's build in a
 * checkout. The hub's server serves it too (ADR 012).
 */
export const webClientDir = (packaged: { readonly resourcesPath: string } | null, mainDir: string) =>
  packaged === null ? resolve(mainDir, "../../../web/dist") : join(packaged.resourcesPath, "web");

/** Whether a URL is one of the local pages, from the app's scheme or, in development, the Vite dev server. */
export const isLocalPage = (url: string, devWebUrl: string | null) =>
  url.startsWith(`${LOCAL_ORIGIN}/`) || (devWebUrl !== null && url.startsWith(`${devWebUrl}/${LOCAL_ENTRY}`));

/**
 * The file a request under the scheme names, inside `root` only. A path with no file extension, such
 * as the root, is the local pages' entry; anything outside `root` or on another host is none.
 */
export const localFile = (root: string, url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${LOCAL_SCHEME}:` || parsed.host !== "app") return null;
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  const last = path.split("/").pop() ?? "";
  if (!last.includes(".")) return join(root, LOCAL_ENTRY);
  const file = resolve(root, `.${path}`);
  const inside = relative(root, file);
  return inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? null : file;
};

/**
 * Answers a request under the app's scheme with the file it names inside `root`, never with
 * anything outside it, so the local pages never load from `file://` themselves (STD-DESKTOP-006).
 * `fetchFile` fetches a `file:` URL, as Electron's `net.fetch` does.
 */
export const localPageResponse =
  (root: string, fetchFile: (url: string) => Promise<Response>) =>
  async (request: { readonly url: string }): Promise<Response> => {
    const file = localFile(root, request.url);
    if (file === null) return new Response("Not found", { status: 404 });
    try {
      return await fetchFile(pathToFileURL(file).toString());
    } catch {
      return new Response("Not found", { status: 404 });
    }
  };
