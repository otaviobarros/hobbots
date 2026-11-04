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

/** Returns one message per problem. `read` returns a repository-relative file's text. */
export const check = (files, read) => files.flatMap((file) => [...fileName(file), ...optOuts(file, read(file))]);
