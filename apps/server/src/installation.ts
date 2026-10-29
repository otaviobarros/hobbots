import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ServerIdentity } from "@hobbots/api";
import { Context, Option, Schema } from "effect";

export type { ServerIdentity };

/** The file in the data folder that names its installation. Clients read it to recognize their server. */
export const installationIdFile = (dataDir: string) => join(dataDir, "installation-id");

/** The data folder's installation ID, or undefined when it has none yet. */
export const readInstallationId = (dataDir: string): string | undefined => {
  try {
    return readFileSync(installationIdFile(dataDir), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
};

/** The data folder's installation ID, created on first start. Two servers racing keep the first ID. */
export const ensureInstallationId = (dataDir: string): string => {
  try {
    writeFileSync(installationIdFile(dataDir), `${randomUUID()}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const id = readInstallationId(dataDir);
  if (id === undefined) throw new Error(`${installationIdFile(dataDir)} holds no installation ID`);
  return id;
};

/** Who this server is, as the health endpoint reports it. */
export class Installation extends Context.Service<Installation, ServerIdentity>()("@hobbots/server/Installation") {}

/** A health response as a server identity, or undefined when it is not one. */
export const parseServerIdentity = (body: unknown): ServerIdentity | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(ServerIdentity)(body));
