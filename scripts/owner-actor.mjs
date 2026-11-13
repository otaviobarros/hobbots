// The owner-actor check (STD-SEC-006): a person's actor comes from the user session, so code names
// `OWNER_ACTOR` only where it is defined, in the migrations that fill stored rows, and in the session
// default (`sessionActor`). The pure parts live here so scripts/owner-actor.test.mjs can feed them
// text; scripts/check-owner-actor.mjs reads the repository.

import { parseSync } from "oxc-parser";

const NAME = "OWNER_ACTOR";

/** Where `OWNER_ACTOR` may be named: its definition, the owner user's id, the session default and migrations. */
export const ALLOWED = [
  /^packages\/domain\/src\/actor\.ts$/,
  /^packages\/domain\/src\/user\.ts$/,
  /^packages\/agents\/src\/users\.ts$/,
  /^packages\/persistence\/src\/migrations\//,
];

/** The source files the check reads: the hub's packages and the apps, without tests and fakes. */
export const isChecked = (file) =>
  /^(?:packages\/[^/]+|apps\/[^/]+)\/src\//.test(file) &&
  /\.tsx?$/.test(file) &&
  !/\.test\.tsx?$/.test(file) &&
  !/\/(?:test|testing)\//.test(file) &&
  !ALLOWED.some((pattern) => pattern.test(file));

/** The lines of a file that name `OWNER_ACTOR` in code: an import, a reference or a property key. Comments do not count. */
export const ownerActorLines = (file, text) => {
  const { program } = parseSync(file, text);
  const lineAt = (offset) => text.slice(0, offset).split("\n").length;
  const lines = new Set();
  const visit = (node) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node.type === "string" && node.type.includes("Identifier") && node.name === NAME) {
      lines.add(lineAt(node.start));
    }
    for (const [key, child] of Object.entries(node)) if (key !== "parent") visit(child);
  };
  visit(program);
  return [...lines].sort((a, b) => a - b);
};

/** One error per line that names `OWNER_ACTOR` outside the allowed files. */
export const check = (files, read) =>
  files
    .filter(isChecked)
    .flatMap((file) =>
      ownerActorLines(file, read(file)).map(
        (line) =>
          `${file}:${line} names ${NAME}. Read the actor from the user session instead (UserSession.actor, or sessionActor for a message), STD-SEC-006.`,
      ),
    );
