import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SkillFiles, SkillLibrary } from "@hobbots/agents";
import { Effect, Layer } from "effect";
import yazl from "yazl";
import { type SkillImporter, SkillImporterLive, type SkillObjects, SkillObjectsLive } from "../src/index.ts";
import { SkillLibraryFake } from "../src/testing.ts";

export const skillMd = (name: string, description = `What ${name} is for.`, extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nSteps for ${name}.\n`;

/** A file of a fixture: its text, or a link when `link` is set, or a script when `executable`. */
export type Fixture = Record<
  string,
  string | { readonly text: string; readonly executable?: boolean; readonly link?: boolean }
>;

export const temp = (prefix: string) => mkdtemp(join(tmpdir(), `hobbots-skills-${prefix}-`));

/** Writes the files of `fixture` into a new folder, and answers it. */
export const folderOf = async (fixture: Fixture): Promise<string> => {
  const root = await temp("folder");
  for (const [path, file] of Object.entries(fixture)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    const spec = typeof file === "string" ? { text: file } : file;
    if (spec.link === true) {
      const { symlink } = await import("node:fs/promises");
      await symlink(spec.text, target);
      continue;
    }
    await writeFile(target, spec.text);
    if (spec.executable === true) await chmod(target, 0o755);
  }
  return root;
};

/** An archive of `fixture`, a link written as one. */
export const archiveOf = (fixture: Fixture): Promise<Uint8Array> => {
  const zip = new yazl.ZipFile();
  for (const [path, file] of Object.entries(fixture)) {
    const spec = typeof file === "string" ? { text: file } : file;
    const mode = spec.link === true ? 0o120777 : spec.executable === true ? 0o100755 : 0o100644;
    zip.addBuffer(Buffer.from(spec.text), path, { mode });
  }
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
};

/** A Git repository of `fixture` with one commit, and that commit. */
export const repositoryOf = async (fixture: Fixture) => {
  const root = await folderOf(fixture);
  const git = (...args: Array<string>) =>
    execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      encoding: "utf8",
    }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("add", "--all");
  git("commit", "--quiet", "--message", "skills");
  return { url: `file://${root}`, root, commit: git("rev-parse", "HEAD"), git };
};

/** The importer on a fake library, with its objects in a new data folder. */
export const importerLayer = async () => {
  const data = await temp("data");
  return {
    data,
    layer: SkillImporterLive.pipe(Layer.provideMerge(Layer.mergeAll(SkillObjectsLive(data), SkillLibraryFake))),
  };
};

export type ImporterServices = SkillImporter | SkillLibrary | SkillObjects | SkillFiles;

export const runWith =
  (layer: Layer.Layer<ImporterServices>) =>
  <A, E>(effect: Effect.Effect<A, E, ImporterServices>) =>
    effect.pipe(Effect.provide(layer), Effect.runPromise);
