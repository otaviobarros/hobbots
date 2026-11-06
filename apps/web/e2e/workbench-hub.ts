import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emptyDataDir, type Hub, removeDataDir, startHub } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";
let folder = "";

/** Stops the hub a test started with `aldricHub` and removes its data and Aldric's folder. */
export const stopAldricHub = async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
  rmSync(folder, { recursive: true, force: true });
};

/**
 * A hub past setup with Aldric, who works in a folder of his own beside the hub's data, holding
 * `files` (text or bytes, by their path inside it) when the hub starts, and a hob for each of
 * `members`, with no folders of its own, whose ids it returns in order. `env` goes to the hub.
 */
export const aldricHub = async (
  files: Readonly<Record<string, string | Uint8Array>> = { "notes.md": "# Notes\n" },
  members: ReadonlyArray<string> = [],
  env: Record<string, string> = {},
) => {
  dataDir = emptyDataDir();
  folder = realpathSync(mkdtempSync(`${dataDir}-aldric-`));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), content);
  }
  hub = await startHub(dataDir, env);
  const { url, headers } = hub;
  const api = async (method: string, path: string, body: unknown) => {
    const response = await fetch(`${url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ readonly id: string }>;
  };
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  const hobNamed = (name: string, lookSeed: number) =>
    api("POST", "/agents", {
      id: randomUUID(),
      name,
      role: "assistant",
      roleTitle: "Assistant",
      sigil: "assistant",
      hat: null,
      tool: null,
      lookSeed,
      lookColor: "amber",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
    });
  const aldric = await hobNamed("Aldric", 4000);
  const ids: Array<string> = [];
  for (const [index, name] of members.entries()) ids.push((await hobNamed(name, 4911 + index * 911)).id);
  await api("PATCH", `/agents/${aldric.id}/permissions`, { ownFolders: [folder] });
  return { url, aldric: aldric.id, members: ids, api, hub, dataDir, folder };
};

/** A prompt line that makes the fake call a Task tool. */
export const script = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;
