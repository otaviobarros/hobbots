# Reuse and duplication standards

Write code once, put it where its layer says, and delete what nothing uses.

### STD-DUP-001 Search before writing

Before you add a helper, Schema, component, hook or service, search the workspace for one that already does the job. Extend it when it fits.

- **Why:** most duplication starts as a helper that already existed one package away.
- **Enforced by:** review.
- **Applies to:** all code.

### STD-DUP-002 Extract logic at its second real copy

When business logic, validation or a protocol appears a second time, extract it. Code that only looks alike but changes for different reasons may stay separate. Add a one-line comment that says why.

- **Why:** two copies of a rule drift apart, and the bug ships in one of them.
- **Enforced by:** review and STD-DUP-006.
- **Applies to:** all code.

### STD-DUP-003 Shared code lives in the layer that owns it

Put shared code where its layer says (STD-ARCH-001):

- Schemas and types go in `packages/domain`.
- HTTP contracts go in `packages/api`.
- UI primitives go in `packages/ui`.
- Pixel art that the app and the site both draw goes in `packages/art`.
- Other helpers go inside the package that owns them.

Name a module after what it does. A grab-bag module or package named `utils`, `helpers`, `common` or `shared` has no owner. The shadcn `cn` helper in `packages/ui/src/lib/utils.ts` is the one exception, because the shadcn CLI expects that path.

- **Why:** code with an owner has one obvious place to look and one place to change.
- **Enforced by:** review.
- **Applies to:** all code.

### STD-DUP-004 Effect Schemas are the single source of a contract

Derive TypeScript types from Effect Schemas, for example `type ThreadId = typeof ThreadId.Type`. Never declare the same shape again by hand.

- **Why:** a hand-written copy of a Schema type compiles after the Schema changes and lies at run time.
- **Enforced by:** review.
- **Applies to:** all code.

### STD-DUP-005 No unused files, exports or dependencies

Delete a file, export or dependency that nothing uses. Keep one only with an entry in `knip.jsonc` and a comment above it that states the reason.

- **Why:** dead code costs review time and hides the code that matters.
- **Enforced by:** knip in `pnpm check` (`pnpm lint:unused`), configured in `knip.jsonc`.
- **Applies to:** all workspaces.

### STD-DUP-006 No copied blocks of code

Copied blocks of code above the detector's threshold fail the check. Tests and generated files are excluded. Extract the shared part. If a repeat is only structural and an extraction would hurt the code, wrap it in `// jscpd:ignore-start` and `// jscpd:ignore-end` with a comment that states the reason.

- **Why:** a detector finds the copies that review misses.
- **Enforced by:** jscpd in `pnpm check` (`pnpm lint:dup`), configured in `.jscpd.json`.
- **Applies to:** all source code except tests and generated files.

### STD-DUP-007 Use an established library before writing your own

Before you write a parser, a validator, a format or protocol reader, a retry or backoff loop, a timer, a cache, a queue or a similar mechanism, look for a library that already does it, and use it:

1. A library the workspace already installs. Check Effect first, then the rest of `pnpm-lock.yaml`.
2. Otherwise, a library from the registry that is established: widely used, maintained (a release in the last year and issues answered), with no open security advisory, and a license the project can ship. Add it as STD-DOCS-006 says.

Read its docs or source for the version you use (STD-DOCS-005). When a layer may not import it, such as the domain (STD-ARCH-002), call the library in the layer that may and pass its result in: the domain stays pure and the library still does the work. Write your own only when no such library covers the case. Say why in a one-line comment, and in the pull request.

- ✅ Effect's `HttpClient`, `Sse.makeParser`, `Stream.retry` with a `Schedule`, and `Stream.timeout` to follow an event stream.
- ✅ Markdown code found by a CommonMark parser (`mdast-util-from-markdown`) in persistence, passed as ranges to the domain's mention matcher.
- ❌ A hand-written SSE parser, fetch loop and backoff timer next to an installed Effect that has all of them.
- ❌ Hand-written code fence and code span rules: each edge case of the spec becomes a bug to find in review (#1455).
- **Why:** a library used by many people is already tested, fixed and kept up to date, and a copy of it is code this project must test and fix alone.
- **Enforced by:** review.
- **Applies to:** all code.

### STD-DUP-008 Markdown is read only by the CommonMark parser

Code that reads Markdown reads it with the CommonMark parser: `mdast-util-from-markdown`, or `micromark` under it when the exact offsets of what was written are needed, and `remark-parse` in `apps/web`, which runs the same parser. That covers headings, code blocks and code spans, links, images and reference definitions, and YAML front matter through `micromark-extension-frontmatter`. Never match Markdown with a regular expression or a string method. The domain reads no Markdown (STD-ARCH-002): its caller parses and passes the result in, as `memoryTitleOf` takes a page's heading. Writing Markdown, such as `# ${title}` in an export, is not reading it.

- ✅ `fromMarkdown(page).children.find((node) => node.type === "heading" && node.depth === 1)` for a page's title.
- ❌ `line.startsWith("# ")` or `/\]\(([^)]+)\)/g`: a heading in a code block, or a link in a code span, is read as real.
- **Why:** the spec has many edge cases (fences in quotes and lists, indented code, escapes, setext headings), and a parser used by many people already handles each one.
- **Enforced by:** `scripts/check-markdown.mjs` in `pnpm check` (`pnpm lint:markdown`) flags regular expressions and string methods that match a fence, an ATX heading, a link destination, a reference definition or a front matter fence, and imports of other Markdown parsers. `scripts/markdown.test.mjs` proves the check. Review covers what the check cannot see.
- **Applies to:** `packages/*/src` and `apps/*/src`, except tests.
