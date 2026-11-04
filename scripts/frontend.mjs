// The frontend checks that look at whole files rather than one pattern in the code.
// Pattern checks run in Biome, through its rules and the GritQL plugins in scripts/biome.

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
    return [...fileName(file), ...optOuts(file, text), ...routes(file, text)];
  });
