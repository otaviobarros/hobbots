import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseServerIdentity, readInstallationId, type ServerIdentity } from "@hobbots/server/installation";

/** What answers on the server's port. */
export type ServerCheck =
  | { readonly kind: "none" }
  | { readonly kind: "ours"; readonly identity: ServerIdentity }
  | { readonly kind: "otherInstallation"; readonly identity: ServerIdentity }
  | { readonly kind: "notHobbots" };

/** This app's installation: its data folder and the ID its server stored there. */
export interface OwnInstallation {
  readonly installationId: string | undefined;
  readonly dataDir: string;
}

const canonicalPath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

export const ownInstallation = (dataDir: string): OwnInstallation => {
  const canonical = canonicalPath(dataDir);
  return { installationId: readInstallationId(canonical), dataDir: canonical };
};

/**
 * Compares a health response with this app's installation. A server of another version is still
 * ours: `pnpm dev` and the packaged app share the data folder.
 */
export const judgeHealth = (body: unknown, own: OwnInstallation): ServerCheck => {
  const identity = parseServerIdentity(body);
  if (identity === undefined) return { kind: "notHobbots" };
  return own.installationId !== undefined &&
    identity.installationId === own.installationId &&
    identity.dataDir === own.dataDir
    ? { kind: "ours", identity }
    : { kind: "otherInstallation", identity };
};

const refused = (error: unknown) =>
  error instanceof Error && (error.cause as NodeJS.ErrnoException | undefined)?.code === "ECONNREFUSED";

/** Asks whatever listens on the port who it is. Anything that answers but is not our server is a stranger. */
export const checkServer = async (apiUrl: string, dataDir: string): Promise<ServerCheck> => {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
  } catch (error) {
    return refused(error) ? { kind: "none" } : { kind: "notHobbots" };
  }
  if (!response.ok) return { kind: "notHobbots" };
  const body: unknown = await response.json().catch(() => undefined);
  // Read after the request, so a server that just created the data folder's ID is recognized.
  return judgeHealth(body, ownInstallation(dataDir));
};

/** The error to show instead of connecting to something that is not this installation's server. */
export const serverProblem = (check: ServerCheck, port: number): { message: string; detail: string } | undefined => {
  switch (check.kind) {
    case "ours":
      return undefined;
    case "none":
      return {
        message: "The Hobbots server did not start",
        detail: `Nothing answered on port ${port}. Open Hobbots again; if it keeps failing, restart the Mac.`,
      };
    case "otherInstallation":
      return {
        message: "Another Hobbots is using the port",
        detail: `A Hobbots server for a different data folder (${check.identity.dataDir}) is running on port ${port}. Quit it, then open Hobbots again.`,
      };
    case "notHobbots":
      return {
        message: `Another program is using port ${port}`,
        detail: `Hobbots needs port ${port}, but a program that is not Hobbots answers there. Quit that program, or start Hobbots with HOBBOTS_PORT set to a free port, then open Hobbots again.`,
      };
  }
};

/** Raised instead of connecting to anything but this installation's server; the app shows it and quits. */
export class ServerProblem extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

/** Throws a ServerProblem unless the check found this installation's server. */
export const requireOurs = (check: ServerCheck, port: number) => {
  const problem = serverProblem(check, port);
  if (problem) throw new ServerProblem(problem.message, problem.detail);
};
