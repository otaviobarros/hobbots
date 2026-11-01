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

### STD-DUP-007 Use what installed libraries provide before writing your own

Before you write a parser, protocol client, retry or backoff loop, timer, cache, queue, validator or similar mechanism, check whether a library the workspace already installs provides it. Check Effect first, then the rest of `pnpm-lock.yaml`. Read the installed version's docs or source (STD-DOCS-005). Use what it provides. Write your own only when no installed library covers the case, or when the library's version does not fit. Say why in a one-line comment, and in the pull request.

- ✅ Effect's `HttpClient`, `Sse.makeParser`, `Stream.retry` with a `Schedule`, and `Stream.timeout` to follow an event stream.
- ❌ A hand-written SSE parser, fetch loop and backoff timer next to an installed Effect that has all of them.
- **Why:** a library's version is already tested and maintained, and a copy of it is code this project must test and fix alone.
- **Enforced by:** review.
- **Applies to:** all code.
