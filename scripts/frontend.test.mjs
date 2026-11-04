import assert from "node:assert/strict";
import { test } from "node:test";
import { check } from "./frontend.mjs";

const files = (texts) => [Object.keys(texts), (file) => texts[file]];

test("kebab-case file names pass", () => {
  const [names, read] = files({
    "apps/web/src/components/hob-profile/hob-profile.tsx": "",
    "apps/web/src/lib/time.test.ts": "",
  });
  assert.deepEqual(check(names, read), []);
});

test("a file name that is not kebab-case fails", () => {
  const [names, read] = files({ "apps/web/src/components/HobProfile.tsx": "", "packages/ui/src/lib/use_copy.ts": "" });
  assert.deepEqual(check(names, read), [
    "apps/web/src/components/HobProfile.tsx: name the file in kebab-case (STD-REACT-007)",
    "packages/ui/src/lib/use_copy.ts: name the file in kebab-case (STD-REACT-007)",
  ]);
});

test("opt-outs with a rule and a reason pass", () => {
  const [names, read] = files({
    "apps/web/src/a.ts": [
      "// standards-allow STD-REACT-006: the generated table stays in one file",
      "// @ts-expect-error the library types miss this overload",
    ].join("\n"),
  });
  assert.deepEqual(check(names, read), []);
});

test("opt-outs without a rule or a reason fail", () => {
  const [names, read] = files({
    "apps/web/src/a.ts": [
      "// @ts-expect-error",
      "// standards-allow: too long",
      "// standards-allow STD-REACT-006:",
    ].join("\n"),
  });
  assert.deepEqual(check(names, read), [
    "apps/web/src/a.ts:1: give @ts-expect-error a reason (STD-REACT-020)",
    'apps/web/src/a.ts:2: write "standards-allow STD-XXX-NNN: <reason>" (STD-REACT-020)',
    'apps/web/src/a.ts:3: write "standards-allow STD-XXX-NNN: <reason>" (STD-REACT-020)',
  ]);
});
