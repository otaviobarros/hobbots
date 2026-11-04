/**
 * The web permissions a page may have (STD-DESKTOP-005). Without a handler Electron grants every
 * request, so each session refuses all of them but the ones a feature needs, and only to the page
 * itself, never to a frame inside it. Electron stays out of this file; index.ts passes each session in.
 */

/** Copying text with the pages' Copy buttons, through `navigator.clipboard.writeText`. */
const ALLOWED: ReadonlySet<string> = new Set(["clipboard-sanitized-write"]);

/** Whether a page may use `permission`: only an allowed one, and only from the window's own page. */
export const allowsPermission = (permission: string, isMainFrame: boolean) => isMainFrame && ALLOWED.has(permission);

/** The part of an Electron session that answers permission requests and checks. */
export interface PermissionSession {
  readonly setPermissionRequestHandler: (
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details: { readonly isMainFrame: boolean },
    ) => void,
  ) => void;
  readonly setPermissionCheckHandler: (
    handler: (
      webContents: unknown,
      permission: string,
      requestingOrigin: string,
      details: { readonly isMainFrame: boolean },
    ) => boolean,
  ) => void;
}

/** Refuses every permission request and check in `session` but the allowed ones. */
export const limitPermissions = (session: PermissionSession) => {
  session.setPermissionRequestHandler((_webContents, permission, callback, details) =>
    callback(allowsPermission(permission, details.isMainFrame)),
  );
  session.setPermissionCheckHandler((_webContents, permission, _origin, details) =>
    allowsPermission(permission, details.isMainFrame),
  );
};
