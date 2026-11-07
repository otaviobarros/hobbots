import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBaseline, check, shrinkBaseline } from "./frontend.mjs";

const files = (texts) => [Object.keys(texts), (file) => texts[file]];

test("kebab-case file names pass", () => {
  const [names, read] = files({
    "apps/web/src/components/hob-profile/hob-profile.tsx": "",
    "apps/web/src/lib/time.test.ts": "",
  });
  assert.deepEqual(check(names, read), []);
});

test("a file name that is not kebab-case fails", () => {
  const [names, read] = files({
    "apps/web/src/components/hob-profile/HobProfile.tsx": "",
    "packages/ui/src/lib/use_copy.ts": "",
  });
  assert.deepEqual(check(names, read), [
    "apps/web/src/components/hob-profile/HobProfile.tsx: name the file in kebab-case (STD-REACT-007)",
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

test("the desktop main process registers IPC only through trusted-ipc.ts", () => {
  const [names, read] = files({
    "apps/desktop/src/main/trusted-ipc.ts": "ipcMain.handle(channel, listener);",
    "apps/desktop/src/main/folder-dialog.ts": "  options.ipcMain.handle(channel, listener);",
    "apps/desktop/src/preload/index.ts": "ipcRenderer.invoke(channel);",
  });
  assert.deepEqual(check(names, read), [
    "apps/desktop/src/main/folder-dialog.ts:1: register IPC handlers with handleTrusted from trusted-ipc.ts (STD-DESKTOP-003)",
  ]);
});

test("the desktop main process makes Sync calls only with a startup opt-out", () => {
  const [names, read] = files({
    "apps/desktop/src/main/settings.ts": [
      "// standards-allow STD-DESKTOP-008: read once when the app starts",
      'const text = readFileSync(file, "utf8");',
      "writeFileSync(file, text);",
      'import { readFileSync } from "node:fs";',
    ].join("\n"),
    "apps/web/src/a.ts": "const value = decodeUnknownSync(schema)(input);",
  });
  assert.deepEqual(check(names, read), [
    "apps/desktop/src/main/settings.ts:3: use the asynchronous call, the main process never blocks (STD-DESKTOP-008)",
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

const long = (count) => Array.from({ length: count }, (_, index) => `export const line${index} = ${index};`).join("\n");
const nested = (depth) => "<a>".repeat(depth) + "</a>".repeat(depth);

test("a component inside a feature folder passes, one at the root of components fails", () => {
  const [names, read] = files({
    "apps/web/src/components/chat/chat-view.tsx": "",
    "apps/web/src/components/messages.ts": "",
    "apps/web/src/components/chat-view.tsx": "",
  });
  assert.deepEqual(check(names, read), [
    "apps/web/src/components/chat-view.tsx: move the component into a feature folder under components/ (STD-REACT-005)",
  ]);
});

test("a .tsx file over 250 lines or nested over 6 elements fails, unless it opts out", () => {
  const [names, read] = files({
    "apps/web/src/components/a/short.tsx": `export const A = () => ${nested(6)};`,
    "apps/web/src/components/a/long.tsx": long(251),
    "apps/web/src/components/a/deep.tsx": `export const A = () => (\n  ${nested(7)}\n);`,
    "apps/web/src/components/a/kept.tsx": `// standards-allow STD-REACT-006: the generated table stays in one file\n${long(300)}`,
    "apps/web/src/lib/long.ts": long(300),
  });
  assert.deepEqual(check(names, read), [
    "apps/web/src/components/a/long.tsx: split the file, it has 251 lines and the limit is 250 (STD-REACT-006)",
    "apps/web/src/components/a/deep.tsx:2: move this JSX into a component, it nests 7 elements deep and the limit is 6 (STD-REACT-006)",
  ]);
});

test("physical classes fail in className, cn and cva, and logical ones pass", () => {
  const [names, read] = files({
    "apps/web/src/components/a/a.tsx": [
      "export const A = () => (",
      '  <div className="ms-2 pe-4 start-0 text-end border-s rounded-e mx-2 inset-x-0" title="ml-2">',
      '    <span className={cn("hover:ml-2", open && "md:!-right-1", { "text-left": open })} />',
      "  </div>",
      ");",
      'const look = cva("pl-2", { variants: { side: { "inline-start": "border-r" } } });',
      'const marks = { done: { className: "rounded-tl-sm" } };',
      "// standards-allow STD-I18N-004: the arrow always points right",
      'export const B = () => <i className="left-0" />;',
    ].join("\n"),
  });
  assert.deepEqual(
    check(names, read).map((error) => error.replace(/, such as .*/, "")),
    [
      'apps/web/src/components/a/a.tsx:3: use the logical class for "hover:ml-2"',
      'apps/web/src/components/a/a.tsx:3: use the logical class for "md:!-right-1"',
      'apps/web/src/components/a/a.tsx:3: use the logical class for "text-left"',
      'apps/web/src/components/a/a.tsx:6: use the logical class for "pl-2"',
      'apps/web/src/components/a/a.tsx:6: use the logical class for "border-r"',
      'apps/web/src/components/a/a.tsx:7: use the logical class for "rounded-tl-sm"',
    ],
  );
});

test("a primitive takes layout classes only", () => {
  const [names, read] = files({
    "apps/web/src/components/a/a.tsx": [
      'import { Button } from "@hobbots/ui/components/button";',
      'import { Dialog } from "@hobbots/ui/components/dialog";',
      "export const A = () => (",
      "  <>",
      '    <Button className={cn("ms-auto w-full md:hidden", wide && "max-w-80")} variant="ghost" />',
      '    <Dialog.Content className="flex gap-2 bg-rose" />',
      '    <div className="bg-rose px-6" />',
      "  </>",
      ");",
    ].join("\n"),
  });
  assert.deepEqual(check(names, read), [
    'apps/web/src/components/a/a.tsx:6: give Dialog.Content a variant for "flex gap-2 bg-rose", a className passed to a primitive holds layout classes only (STD-UI-010)',
  ]);
});

test("a feature component with a className prop fails, a primitive may take one", () => {
  const [names, read] = files({
    "apps/web/src/components/a/a.tsx": [
      "type CardProps = { title: string; className?: string };",
      "export function Card({ title }: CardProps) { return <p>{title}</p>; }",
      "export const Tag = ({ className }: { className: string }) => <i className={className} />;",
      'const marks = { done: { text: "!", className: "text-lantern" } };',
    ].join("\n"),
    "packages/ui/src/components/badge.tsx":
      "export function Badge({ className }: { className?: string }) { return <i className={className} />; }",
  });
  assert.deepEqual(check(names, read), [
    "apps/web/src/components/a/a.tsx:1: take the className prop off CardProps, feature components set their own look (STD-UI-010)",
    "apps/web/src/components/a/a.tsx:3: take the className prop off Tag, feature components set their own look (STD-UI-010)",
  ]);
});

test("classes that depend on a condition or join others go through cn", () => {
  const [names, read] = files({
    "apps/web/src/components/a/a.tsx": [
      'const A = ({ on }: { on: boolean }) => <i className={cn("flex", on && "gap-2")} />;',
      // A template with a hole, written in two pieces so the test file itself holds no `${`.
      "const B = ({ on }: { on: boolean }) => <i className={`flex $" + '{on ? "gap-2" : ""}`} />;',
      'const C = ({ on }: { on: boolean }) => <i className={on ? "flex" : "grid"} />;',
      'const D = ({ more }: { more: string }) => <i className={"flex " + more} />;',
      'const E = ({ on }: { on: boolean }) => <i className={["flex", on && "gap-2"].join(" ")} />;',
      "const F = () => <i className={`flex gap-2`} />;",
      "// standards-allow STD-UI-012: a reason",
      'const G = ({ on }: { on: boolean }) => <i className={on ? "flex" : "grid"} />;',
    ].join("\n"),
  });
  assert.deepEqual(check(names, read), [
    "apps/web/src/components/a/a.tsx:2: compose the classes with cn, not by hand (STD-UI-012)",
    "apps/web/src/components/a/a.tsx:3: compose the classes with cn, not by hand (STD-UI-012)",
    "apps/web/src/components/a/a.tsx:4: compose the classes with cn, not by hand (STD-UI-012)",
    "apps/web/src/components/a/a.tsx:5: compose the classes with cn, not by hand (STD-UI-012)",
  ]);
});

test("dates and numbers are formatted only in the shared formatters", () => {
  const [names, read] = files({
    "apps/web/src/lib/format.ts": "export const f = (n) => new Intl.NumberFormat().format(n);",
    "apps/web/src/api/a.ts": [
      "export const a = (d) => d.toLocaleDateString();",
      "export const b = (n) => new Intl.NumberFormat().format(n);",
      "export const c = (s) => s.toLocaleLowerCase();",
    ].join("\n"),
    "apps/desktop/src/main/a.ts": "export const d = (n) => n.toLocaleString();",
  });
  assert.deepEqual(check(names, read), [
    "apps/web/src/api/a.ts:1: format through apps/web/src/lib/format.ts or time.ts (STD-I18N-003)",
    "apps/web/src/api/a.ts:2: format through apps/web/src/lib/format.ts or time.ts (STD-I18N-003)",
    "apps/desktop/src/main/a.ts:1: format through apps/web/src/lib/format.ts or time.ts (STD-I18N-003)",
  ]);
});

test("the baseline lets listed problems pass, fails on a new one and asks to shrink when one is fixed", () => {
  const rule = "(STD-REACT-006)";
  const baseline = { "STD-REACT-006": { "a.tsx": 1, "b.tsx": 2 } };
  assert.deepEqual(
    applyBaseline([`a.tsx: long ${rule}`, `b.tsx: long ${rule}`, `b.tsx:3: deep ${rule}`], baseline),
    [],
  );
  assert.deepEqual(applyBaseline([`a.tsx: long ${rule}`, `a.tsx:9: deep ${rule}`, `c.tsx: long ${rule}`], baseline), [
    `a.tsx: long ${rule}`,
    `a.tsx:9: deep ${rule}`,
    `c.tsx: long ${rule}`,
    'b.tsx: 0 of 2 baselined STD-REACT-006 problems are left, run "node scripts/check-frontend.mjs --shrink-baseline"',
  ]);
  assert.deepEqual(shrinkBaseline([`a.tsx: long ${rule}`, `a.tsx:2: deep ${rule}`], baseline), {
    "STD-REACT-006": { "a.tsx": 1 },
  });
});
