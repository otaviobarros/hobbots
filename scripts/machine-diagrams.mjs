// The pages scripts/machines.mjs writes into docs/architecture/machines/ (ADR 037, STD-ARCH-013),
// and the check that fails when one is missing, out of date or names no machine. Pure, so
// scripts/machine-diagrams.test.mjs tests it without reading the machines.

/** A machine's page file name. */
export const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/** The page for one machine: its diagram and its table of events. */
export const render = ({ exportName, machine, module }) => {
  const lines = ["stateDiagram-v2"];
  for (const row of machine.table) {
    for (const from of row.from) lines.push(`  ${from} --> ${row.to}: ${row.event}${row.guarded ? " (guarded)" : ""}`);
  }
  const leaves = machine.states.filter((state) => !machine.table.some((row) => row.from.includes(state)));
  for (const state of leaves) lines.push(`  ${state} --> [*]`);
  const rows = machine.table.map(
    (row) => `| ${row.event} | ${row.from.join(", ")} | ${row.to} | ${row.guarded ? "yes" : "no"} |`,
  );
  return [
    `# ${machine.name}`,
    "",
    `Written by \`scripts/machines.mjs\` from \`${exportName}\` in \`${module}\`. Do not edit it by hand: change the machine and run \`pnpm docs:machines\`.`,
    "",
    `Its state is in the \`${machine.field}\` field.`,
    "",
    "| State | Meaning |",
    "| --- | --- |",
    ...machine.states.map((state) => `| ${state} | ${machine.meanings[state]} |`),
    "",
    "```mermaid",
    ...lines,
    "```",
    "",
    "| Event | From | To | Guarded |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
};

/**
 * What is wrong with the diagrams on disk: `pages` maps each file to the text it should hold,
 * `existing` lists the files there, and `read` reads one.
 */
export const diagramProblems = (pages, existing, read) => [
  ...[...pages].flatMap(([file, text]) => {
    if (!existing.includes(file)) return [`docs/architecture/machines/${file} is missing`];
    return read(file) === text ? [] : [`docs/architecture/machines/${file} is out of date`];
  }),
  ...existing.filter((file) => !pages.has(file)).map((file) => `docs/architecture/machines/${file} names no machine`),
];
