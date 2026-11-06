import { type Dirent, existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { RuntimeError } from "@hobbots/agents";
import { Effect } from "effect";
import type { SkillFolder } from "../skills.ts";
import type { AppServer } from "./app-server.ts";
import type { SkillMetadata } from "./protocol.ts";

/** How deep Hobbots looks for a `SKILL.md` under a root Codex scans; the check catches anything deeper. */
const MAX_DEPTH = 6;

/** Every `SKILL.md` under `root`, following no link, which Codex would list as a skill. */
const skillFiles = (root: string, depth = 0): ReadonlyArray<string> => {
  if (depth > MAX_DEPTH || !existsSync(root)) return [];
  let entries: ReadonlyArray<Dirent>;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === "SKILL.md") return [path];
    // Codex follows a linked folder, so a link to one is searched too.
    if (entry.isDirectory() || entry.isSymbolicLink()) return skillFiles(path, depth + 1);
    return [];
  });
};

/** The folders from the repository's root, or `cwd` outside one, down to `cwd`. */
const projectFolders = (cwd: string, root: string | undefined): ReadonlyArray<string> => {
  if (root === undefined || relative(root, cwd).startsWith("..")) return [cwd];
  const folders: Array<string> = [];
  for (let at = cwd; ; at = dirname(at)) {
    folders.unshift(at);
    if (at === root || dirname(at) === at) return folders;
  }
};

/**
 * The roots Codex 0.166.0 lists skills from that Hobbots does not use (ADR 029): `~/.agents/skills`,
 * the hob's own `CODEX_HOME/skills`, and each `.agents/skills` and `.codex/skills` from the
 * repository's root down to the folder the turn starts in.
 */
export const unusedSkillRoots = (
  codexHome: string,
  cwd: string,
  repositoryRoot: string | undefined,
  userHome: string = homedir(),
) => [
  join(userHome, ".agents", "skills"),
  join(codexHome, "skills"),
  ...projectFolders(cwd, repositoryRoot).flatMap((folder) => [
    join(folder, ".agents", "skills"),
    join(folder, ".codex", "skills"),
  ]),
];

/**
 * The App Server's settings that turn off every skill Hobbots did not mount (ADR 029): the bundled
 * skills, and one rule with `enabled = false` for each `SKILL.md` under the roots Hobbots does not
 * use. Given on the command line, so overlapping turns in different folders never share them.
 */
export const skillSettings = (roots: ReadonlyArray<string>): ReadonlyArray<string> => {
  const rules = [...new Set(roots.flatMap((root) => skillFiles(root)))]
    .sort()
    .map((path) => `{ path = ${JSON.stringify(path)}, enabled = false }`);
  return ["-c", "skills.bundled.enabled=false", "-c", `skills.config=[${rules.join(", ")}]`];
};

const realOrSelf = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const inside = (path: string, folder: string) => path.startsWith(`${folder}${sep}`);

/** Why a turn did not start: the skills Codex would load that Hobbots did not give the hob. */
export const unexpectedSkillsMessage = (skills: ReadonlyArray<SkillMetadata>) =>
  `Codex would load skills Hobbots did not give this hob (${skills
    .map((skill) => `${skill.name} from ${skill.path}`)
    .join("; ")}), so the turn did not start. Remove them from that folder, or import them into Hobbots.`;

/** What `skills/list` showed before the turn: the skills an administrator's settings bring. */
export interface AdmittedSkills {
  readonly organization: ReadonlyArray<string>;
}

/**
 * Hands the App Server the turn's skills and checks what it would load (ADR 029): the turn's folder
 * as its only extra root, then `skills/list`. Every enabled skill must come from that folder or from
 * an administrator's settings (scope `admin`), which Hobbots leaves in force; anything else stops the
 * turn before it starts.
 */
export const admitSkills = (
  server: AppServer,
  folder: SkillFolder | null,
  cwd: string,
): Effect.Effect<AdmittedSkills, RuntimeError> =>
  Effect.gen(function* () {
    const fail = (error: { readonly message: string }) => new RuntimeError({ message: error.message });
    yield* server
      .request("skills/extraRoots/set", { extraRoots: folder ? [folder.skills] : [] })
      .pipe(Effect.mapError(fail));
    const listed = yield* server.request("skills/list", { cwds: [cwd], forceReload: true }).pipe(Effect.mapError(fail));
    // Without an answer Hobbots cannot tell what Codex would load, so the turn does not start.
    if (!Array.isArray(listed?.data)) {
      return yield* Effect.fail(new RuntimeError({ message: "Codex did not say which skills it would load." }));
    }
    const mounted = folder ? [folder.skills, realOrSelf(folder.skills)] : [];
    const enabled = listed.data.flatMap((entry) => entry.skills).filter((skill) => skill.enabled);
    const organization = enabled.filter((skill) => skill.scope === "admin");
    const unexpected = enabled.filter(
      (skill) =>
        skill.scope !== "admin" &&
        !mounted.some((root) => inside(skill.path, root) || inside(realOrSelf(skill.path), root)),
    );
    if (unexpected.length > 0)
      return yield* Effect.fail(new RuntimeError({ message: unexpectedSkillsMessage(unexpected) }));
    return { organization: [...new Set(organization.map((skill) => skill.name))].sort() };
  });
