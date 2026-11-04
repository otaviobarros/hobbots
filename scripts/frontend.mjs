// The frontend checks that look at whole files rather than one pattern in the code.
// Pattern checks run in Biome, through its rules and the GritQL plugins in scripts/biome.

import { checkSource } from "./frontend-source.mjs";

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+)*\.(?:ts|tsx)$/;
const EXPECT_ERROR = /@ts-expect-error(.*)$/;
const ALLOW = /standards-allow(.*)$/;
const ALLOW_FORM = /^ STD-[A-Z0-9]+-\d{3}: \S/;

/** File names are kebab-case (STD-REACT-007). */
const fileName = (file) => {
  const name = file.split("/").at(-1);
  return KEBAB.test(name) ? [] : [`${file}: name the file in kebab-case (STD-REACT-007)`];
};

/** Every opt-out gives its reason, and a standards-allow names its rule (STD-REACT-020). */
const optOuts = (file, text) =>
  text.split("\n").flatMap((line, index) => {
    const at = `${file}:${index + 1}`;
    const expect = line.match(EXPECT_ERROR);
    if (expect && expect[1].trim() === "") return [`${at}: give @ts-expect-error a reason (STD-REACT-020)`];
    const allow = line.match(ALLOW);
    if (allow && !ALLOW_FORM.test(allow[1]))
      return [`${at}: write "standards-allow STD-XXX-NNN: <reason>" (STD-REACT-020)`];
    return [];
  });

const ROUTE_CALL = /\b(createRoute|createRootRoute|createRootRouteWithContext<[^>]*>\(\)|createRouter)\(\s*\{/g;
const VALIDATE_SEARCH = /\bvalidateSearch\s*:\s*/g;
const SCHEMA_VALIDATOR = /^Schema\.toStandardSchemaV1\(/;

/** Where the string, comment or other single character at `index` ends, so a brace in it is not counted. */
const tokenEnd = (text, index) => {
  const char = text[index];
  if (char === '"' || char === "'" || char === "`") {
    let end = index + 1;
    while (end < text.length && text[end] !== char) end += text[end] === "\\" ? 2 : 1;
    return end;
  }
  if (char === "/" && text[index + 1] === "/") {
    const end = text.indexOf("\n", index);
    return end === -1 ? text.length : end;
  }
  if (char === "/" && text[index + 1] === "*") {
    const end = text.indexOf("*/", index);
    return end === -1 ? text.length : end + 1;
  }
  return index;
};

/** Where the object literal that opens at `start` closes. */
const closingBrace = (text, start) => {
  let depth = 0;
  for (let index = start; index < text.length; index = tokenEnd(text, index) + 1) {
    if (text[index] === "{") depth++;
    else if (text[index] === "}" && --depth === 0) return index;
  }
  return text.length;
};

const lineAt = (text, index) => text.slice(0, index).split("\n").length;

/**
 * Every route has an error screen and the router a default one (STD-REACT-014), and every
 * `validateSearch` is an Effect Schema (STD-REACT-002).
 */
const routes = (file, text) => {
  const errors = [];
  for (const match of text.matchAll(ROUTE_CALL)) {
    const open = match.index + match[0].length - 1;
    const options = text.slice(open, closingBrace(text, open) + 1);
    const at = `${file}:${lineAt(text, match.index)}`;
    if (match[1] === "createRouter") {
      if (!/\bdefaultErrorComponent\s*:/.test(options))
        errors.push(`${at}: give the router a defaultErrorComponent (STD-REACT-014)`);
    } else if (!/\berrorComponent\s*:/.test(options)) {
      errors.push(`${at}: give the route an errorComponent (STD-REACT-014)`);
    }
  }
  for (const match of text.matchAll(VALIDATE_SEARCH)) {
    if (!SCHEMA_VALIDATOR.test(text.slice(match.index + match[0].length)))
      errors.push(
        `${file}:${lineAt(text, match.index)}: pass validateSearch an Effect Schema through Schema.toStandardSchemaV1 (STD-REACT-002)`,
      );
  }
  return errors;
};

/** Returns one message per problem. `read` returns a repository-relative file's text. */
export const check = (files, read) =>
  files.flatMap((file) => {
    const text = read(file);
    return [...fileName(file), ...optOuts(file, text), ...routes(file, text), ...checkSource(file, text)];
  });

const RULE = /\((STD-[A-Z0-9]+-\d{3})\)$/;
const fileOf = (message) => message.slice(0, message.search(/:(?:\d+:)? /));

/** How many problems each file has for each rule, as `{ rule: { file: count } }`. */
export const countByRule = (errors) => {
  const counts = {};
  for (const error of errors) {
    const rule = error.match(RULE)?.[1];
    if (rule === undefined) continue;
    counts[rule] ??= {};
    counts[rule][fileOf(error)] = (counts[rule][fileOf(error)] ?? 0) + 1;
  }
  return counts;
};

/**
 * Drops the problems that the baseline lists, `{ rule: { file: count } }`, while a file has no more
 * of them than it lists. A file that gains one reports them all. A file that has fewer asks for the
 * baseline to shrink, so a fixed problem cannot come back unnoticed.
 */
export const applyBaseline = (errors, baseline) => {
  const counts = countByRule(errors);
  const kept = errors.filter((error) => {
    const rule = error.match(RULE)?.[1];
    const allowed = rule === undefined ? undefined : baseline[rule]?.[fileOf(error)];
    return allowed === undefined || counts[rule][fileOf(error)] > allowed;
  });
  const shrunk = Object.entries(baseline).flatMap(([rule, files]) =>
    Object.entries(files)
      .filter(([file, allowed]) => (counts[rule]?.[file] ?? 0) < allowed)
      .map(
        ([file, allowed]) =>
          `${file}: ${counts[rule]?.[file] ?? 0} of ${allowed} baselined ${rule} problems are left, run "node scripts/check-frontend.mjs --shrink-baseline"`,
      ),
  );
  return [...kept, ...shrunk];
};

/** The baseline lowered to the current counts. It never grows and drops a file with none left. */
export const shrinkBaseline = (errors, baseline) => {
  const counts = countByRule(errors);
  const shrunk = {};
  for (const [rule, files] of Object.entries(baseline))
    for (const [file, allowed] of Object.entries(files)) {
      const count = Math.min(allowed, counts[rule]?.[file] ?? 0);
      if (count === 0) continue;
      shrunk[rule] ??= {};
      shrunk[rule][file] = count;
    }
  return shrunk;
};
