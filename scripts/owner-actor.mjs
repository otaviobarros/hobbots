// The actor checks. Two rules, read from the same sources:
// - STD-SEC-006: a person's actor comes from the user session, so code names `OWNER_ACTOR` only where
//   it is defined, in the migrations that fill stored rows, and in the session default (`sessionActor`).
// - STD-ARCH-020: a record names who did something with an `Actor`, never a bare user or hob id.
// The pure parts live here so scripts/owner-actor.test.mjs can feed them text;
// scripts/check-owner-actor.mjs and scripts/check-standards.mjs read the repository.

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

// STD-ARCH-020 ------------------------------------------------------------------------------------

/** A field that says who did something: `requestedBy`, `author`, and the like. */
const WHO = /(?:By|^author|^actor|^creator|^requester)$/;

/** The schemas of a bare id of a person or a hob, which say nothing of what kind of actor it is. */
const BARE_IDS = new Set(["UserId", "AgentId", "HobId"]);

/**
 * The fields that named a hob by a bare id when the rule was turned on, by file and field. They pass
 * until they move to an `Actor`, and the list only shrinks: an entry that no longer matches fails too.
 */
export const KNOWN_BARE_AUTHORS = new Set([
  "packages/domain/src/agent.ts summonedBy",
  "packages/domain/src/quest.ts reachedBy",
]);

/** The source files the record check reads: the hub's packages and the apps, without tests and fakes. */
export const isRecordChecked = (file) =>
  /^(?:packages\/[^/]+|apps\/[^/]+)\/src\//.test(file) &&
  /\.tsx?$/.test(file) &&
  !/\.test\.tsx?$/.test(file) &&
  !/\/(?:test|testing)\//.test(file) &&
  !/\/fake[^/]*\.tsx?$/.test(file);

/** The Schema wrappers a bare id may sit in and still be one, such as `Schema.NullOr(AgentId)`. */
const WRAPPERS = new Set(["NullOr", "optional", "optionalKey", "UndefinedOr", "NullishOr", "Array", "mutableKey"]);

/**
 * Whether a field's value is the schema of a bare id: `UserId`, a wrapper of one, or either piped,
 * as in `Schema.NullOr(AgentId).pipe(…)`. A value built at run time, such as an Actor
 * `{ kind: "user", id: UserId.make(…) }` or `userActor(id)`, is not a schema and never counts.
 */
const isBareIdSchema = (node) => {
  if (node?.type === "Identifier") return BARE_IDS.has(node.name);
  if (node?.type !== "CallExpression" || node.callee?.type !== "MemberExpression") return false;
  const { object, property } = node.callee;
  if (property?.name === "pipe") return isBareIdSchema(object);
  return object?.type === "Identifier" && object.name === "Schema" && WRAPPERS.has(property?.name)
    ? node.arguments.some(isBareIdSchema)
    : false;
};

/**
 * The fields of a file that say who did something with a bare user or hob id, such as
 * `requestedBy: UserId` or `author: Schema.NullOr(AgentId)`, each with its line. A value that is
 * not a schema, such as `reachedBy: task.ownerId` or an Actor, does not count.
 */
export const bareAuthorFields = (file, text) => {
  const { program } = parseSync(file, text);
  const lineAt = (offset) => text.slice(0, offset).split("\n").length;
  const found = [];
  const visit = (node) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node.type === "Property" && !node.computed) {
      const name = node.key?.name ?? node.key?.value;
      if (typeof name === "string" && WHO.test(name) && isBareIdSchema(node.value)) {
        found.push({ field: name, line: lineAt(node.start) });
      }
    }
    for (const [key, child] of Object.entries(node)) if (key !== "parent") visit(child);
  };
  visit(program);
  return found;
};

/** One error per field outside the known list that names who did something with a bare id, and per stale entry. */
export const checkRecords = (files, read, known = KNOWN_BARE_AUTHORS) => {
  const seen = new Set();
  const errors = files.filter(isRecordChecked).flatMap((file) =>
    bareAuthorFields(file, read(file)).flatMap(({ field, line }) => {
      const key = `${file} ${field}`;
      seen.add(key);
      if (known.has(key)) return [];
      return [
        `${file}:${line} says who did something in "${field}" with a bare user or hob id. Use an Actor ({ kind, id }) instead, STD-ARCH-020.`,
      ];
    }),
  );
  const stale = [...known]
    .filter((key) => !seen.has(key))
    .map((key) => `"${key}" no longer names a bare id: remove it from KNOWN_BARE_AUTHORS in scripts/owner-actor.mjs.`);
  return [...errors, ...stale];
};
