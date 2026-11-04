// Runs Biome with the repository's biome.json over probe files, to prove the hard-coded copy checks (STD-I18N-001).

import { before, test } from "node:test";
import { lintProbes } from "./biome-probes.mjs";

const LITERALS = "lint/style/noJsxLiterals";
const PLUGIN = "plugin";

/** Each probe renders one element, so a diagnostic points at exactly one case. */
const probes = {
  "apps/web/src/text.tsx": "<p>Summon a hob</p>",
  "packages/ui/src/text.tsx": "<p>Summon a hob</p>",
  "apps/web/src/message.tsx": "<p>{messages.title}</p>",
  "apps/web/src/glyph.tsx": '<span aria-hidden="true">·</span>',
  "apps/web/src/brand.tsx": "<header>Hobbots</header>",
  "apps/web/src/aria-label.tsx": '<button type="button" aria-label="Close" />',
  "apps/web/src/title.tsx": '<span title="Your own" />',
  "apps/web/src/placeholder.tsx": '<input placeholder="Search hobs" />',
  "apps/web/src/alt.tsx": '<img alt="A hob" src="hob.png" />',
  "apps/web/src/expression.tsx": '<img alt={"A hob"} src="hob.png" />',
  "apps/web/src/template.tsx": "<span title={`Look ${seed}`} />",
  "apps/web/src/decorative.tsx": '<img alt="" src="hob.png" />',
  "apps/web/src/from-messages.tsx": '<button type="button" aria-label={messages.close} />',
  "apps/web/src/other-prop.tsx": '<span className="text-label" data-state="open" aria-labelledby="name" />',
  "apps/server/src/text.tsx": '<p title="Not checked here">Not checked here</p>',
};

let fails;
let passes;

before(() => {
  ({ fails, passes } = lintProbes(
    Object.fromEntries(
      Object.entries(probes).map(([file, jsx]) => [
        file,
        `const messages = { title: "", close: "" };\nconst seed = 1;\nexport const Probe = () => ${jsx};\n`,
      ]),
    ),
  ));
});

test("text between tags fails in the web app and the UI package", () => {
  fails("apps/web/src/text.tsx", LITERALS);
  fails("packages/ui/src/text.tsx", LITERALS);
});

test("copy read from a message module, glyphs and the product name pass", () => {
  for (const file of ["message", "glyph", "brand"]) passes(`apps/web/src/${file}.tsx`, LITERALS);
});

test("a literal aria-label, title, placeholder or alt fails", () => {
  for (const file of ["aria-label", "title", "placeholder", "alt", "expression", "template"]) {
    fails(`apps/web/src/${file}.tsx`, PLUGIN);
  }
});

test("an empty alt, copy from a message module and other props pass", () => {
  for (const file of ["decorative", "from-messages", "other-prop"]) passes(`apps/web/src/${file}.tsx`, PLUGIN);
});

test("code outside the web app and the UI package is not checked", () => {
  passes("apps/server/src/text.tsx", LITERALS);
  passes("apps/server/src/text.tsx", PLUGIN);
});
