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

Delete a file, export or dependency that nothing uses. Keep one only with an ignore entry that states the reason.

- **Why:** dead code costs review time and hides the code that matters.
- **Enforced by:** review. A knip check is planned.
- **Applies to:** all workspaces.

### STD-DUP-006 No copied blocks of code

Copied blocks of code above the detector's threshold fail the check. Tests and generated files are excluded.

- **Why:** a detector finds the copies that review misses.
- **Enforced by:** review. A jscpd check is planned.
- **Applies to:** all source code except tests and generated files.
