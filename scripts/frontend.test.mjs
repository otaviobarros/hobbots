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

test("routes with an error screen and schema search pass", () => {
  const [names, read] = files({
    "apps/web/src/router.tsx": [
      "const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({",
      "  component: AppWindow,",
      "  errorComponent: AppError,",
      "});",
      "const hobsRoute = createRoute({",
      '  path: "hobs", // a comment with a } brace',
      "  validateSearch: Schema.toStandardSchemaV1(Schema.Struct({ show: searchParam(HobFilter) })),",
      '  component: () => <HobsPage filter="}" />,',
      "  errorComponent: (props) => <PageError error={props.error} />,",
      "});",
      "createRouter({ routeTree, defaultErrorComponent: ScreenError });",
    ].join("\n"),
  });
  assert.deepEqual(check(names, read), []);
});

test("a route without an error screen or with a hand-written validateSearch fails", () => {
  const [names, read] = files({
    "apps/web/src/router.tsx": [
      "const hobsRoute = createRoute({",
      '  path: "hobs",',
      "  validateSearch: (search) => ({ show: search.show }),",
      "  component: () => <HobsPage errorComponent={1} />,",
      "});",
      "createRouter({ routeTree });",
    ].join("\n"),
  });
  assert.deepEqual(check(names, read), [
    "apps/web/src/router.tsx:1: give the route an errorComponent (STD-REACT-014)",
    "apps/web/src/router.tsx:6: give the router a defaultErrorComponent (STD-REACT-014)",
    "apps/web/src/router.tsx:3: pass validateSearch an Effect Schema through Schema.toStandardSchemaV1 (STD-REACT-002)",
  ]);
});
