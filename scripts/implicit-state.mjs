// The implicit-state check (STD-ARCH-013): a service keeps no lifecycle state in a Set or Map keyed by
// an id. Such a collection, held for the life of a service, is a state machine nobody declared: its
// legal combinations with the service's other collections are written nowhere (ADR 037).
//
// It flags a `new Set<…Id>` or `new Map<…Id, …>` declared at module level or directly in the body of
// a generator, the `Effect.gen(function* () { … })` that builds a service. A collection built and
// used inside one plain function, such as a fold, is not state and is not flagged. A deliberate case
// says why with `standards-allow STD-ARCH-013: <reason>` on its line or the line above.

import { parseSync, visitorKeys } from "oxc-parser";

const RULE = "STD-ARCH-013";
const KEYED_BY_ID = /Id$/;

/** The name of the first type argument of `new Set<…>` or `new Map<…>`, when it is a type name ending in Id. */
const idKey = (node) => {
  if (node?.type !== "NewExpression" || node.callee?.type !== "Identifier") return undefined;
  if (node.callee.name !== "Set" && node.callee.name !== "Map") return undefined;
  const first = node.typeArguments?.params?.[0];
  if (first?.type !== "TSTypeReference" || first.typeName?.type !== "Identifier") return undefined;
  return KEYED_BY_ID.test(first.typeName.name) ? first.typeName.name : undefined;
};

const isFunction = (node) =>
  node.type === "FunctionExpression" || node.type === "FunctionDeclaration" || node.type === "ArrowFunctionExpression";

/** The problems in one file, as `file:line: message (STD-ARCH-013)`. */
export const checkFile = (file, text) => {
  const { program, errors } = parseSync(file, text);
  if (errors.length > 0) return [];
  const lines = text.split("\n");
  const marker = `standards-allow ${RULE}:`;
  const problems = [];

  const walk = (node) => {
    if (node === null || typeof node !== "object" || typeof node.type !== "string") return;
    if (isFunction(node) && node.generator && node.body?.type === "BlockStatement") {
      statements(node.body.body);
      return;
    }
    for (const key of visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) for (const item of child) walk(item);
      else walk(child);
    }
  };

  // Statements directly in the module or a generator's body: a collection declared here lives as long
  // as the service or the module.
  const statements = (list) => {
    for (const statement of list) {
      const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
      if (declaration?.type !== "VariableDeclaration") {
        walk(statement);
        continue;
      }
      for (const each of declaration.declarations) {
        const key = idKey(each.init);
        if (key === undefined) {
          walk(each.init);
          continue;
        }
        const line = text.slice(0, each.start).split("\n").length;
        if ((lines[line - 1] ?? "").includes(marker) || (lines[line - 2] ?? "").includes(marker)) continue;
        problems.push(
          `${file}:${line}: \`${each.id?.name ?? "collection"}\` is a collection keyed by ${key} held for a service's or module's life; make it one explicit machine, or move a fold into a plain function (${RULE})`,
        );
      }
    }
  };

  statements(program.body);
  return problems;
};

/** Every problem in `files`, read with `read`. */
export const check = (files, read) => files.flatMap((file) => checkFile(file, read(file)));
