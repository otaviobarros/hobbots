import { randomUUID } from "node:crypto";
import { emptyDataDir, type Hub, removeDataDir, startHub } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

/** Stops the hub a test started with `questHub` and removes its data. */
export const stopQuestHub = async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
};

/**
 * A hub past setup that plays the scripted Black Friday Quest, with Aldric, Quill and Ada. With
 * `nested`, Rook and Pip join too, and Rook leads a Quest of his own under Aldric's.
 */
export const questHub = async ({ nested = false }: { readonly nested?: boolean } = {}) => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir, { HOBBOTS_FAKE_QUEST: "black-friday" });
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
  const ids: Record<string, string> = {};
  const names = nested ? ["Aldric", "Quill", "Ada", "Rook", "Pip"] : ["Aldric", "Quill", "Ada"];
  for (const [index, name] of names.entries()) {
    const hob = await api("POST", "/agents", {
      id: randomUUID(),
      name,
      role: "assistant",
      roleTitle: "Assistant",
      sigil: "assistant",
      hat: null,
      tool: null,
      lookSeed: 4000 + index * 911,
      lookColor: (["amber", "sky", "moss", "amber", "sky"] as const)[index],
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
    });
    ids[name] = hob.id;
  }
  return { url, aldric: String(ids.Aldric) };
};
