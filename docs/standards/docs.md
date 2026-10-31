# Docs and workflow standards

Rules for decisions, documentation, commits and how work is done.

### STD-DOCS-001 Decided choices change only through an ADR

Keep decided requirements and contracts apart from [open questions](../product/open-questions.md). To change a decided choice, write a new or updated ADR with the rationale. Never replace a decision silently in code or docs.

- **Why:** the ADRs are the record of why the system looks as it does.
- **Enforced by:** review.
- **Applies to:** all changes.

### STD-DOCS-002 Read the contract before changing its area

Before you change an area, read its contract in `docs/architecture/`. [AGENTS.md](../../AGENTS.md) maps each area to its contract. A change to a contract updates it in the same pull request.

- **Why:** the contract holds the invariants that the code alone does not show.
- **Enforced by:** review.
- **Applies to:** all changes.

### STD-DOCS-003 Public text links only public sources

Hobbots is public. Code, comments, docs, commits, issues and pull requests link only to sources that anyone can open. Never include secrets, tokens or private file contents.

- **Why:** a private link is a dead end for contributors, and a secret in history is leaked forever.
- **Enforced by:** review.
- **Applies to:** everything in the repository and on GitHub.

### STD-DOCS-004 Commits follow Conventional Commits

Write every commit message as a [Conventional Commit](https://www.conventionalcommits.org/). A pull request closes its issue with `Closes #N`.

- **Why:** commit types decide the next version and the changelog. See [Releases](../contributing/releases.md).
- **Enforced by:** review.
- **Applies to:** commits and pull requests.

### STD-DOCS-005 Library knowledge comes from current docs

Before library-specific API or configuration work, fetch the current docs for the installed version through Context7, or from the library's official docs. Memory is not a source.

- **Why:** libraries in this stack change quickly, and old APIs compile until they fail.
- **Enforced by:** review.
- **Applies to:** all changes that touch a library API or config.

### STD-DOCS-006 Dependencies take the latest stable release, pinned exactly

Add a dependency with `pnpm add <pkg>`. It takes the latest stable release from the registry and records that exact version, with no `^` or `~` range. Release candidates are allowed. Alpha, beta and nightly releases are not. Never type a version by hand. To upgrade, run `pnpm add <pkg>` or `pnpm update --latest <pkg>` on purpose, then run `pnpm check`. Effect packages take their version from the workspace catalog (STD-EFFECT-005).

- **Why:** current releases carry fixes, and an exact version changes only when someone upgrades it, so packages never drift apart on a later install.
- **Enforced by:** `saveExact` in `pnpm-workspace.yaml`, and review.
- **Applies to:** every `package.json`.

### STD-DOCS-007 Docs use short, plain sentences

Write docs, comments and agent instructions in short sentences in the active voice, one idea per sentence. Use one name for one thing throughout a document. Link to the source of truth rather than copying it.

- **Why:** people and agents both misread long, hedged sentences, and copied text goes stale.
- **Enforced by:** review.
- **Applies to:** Markdown docs, code comments, skills and `AGENTS.md`.

### STD-DOCS-008 Work stays inside the requested scope

Do the work the task asks for. Raise a material contradiction between the task and a decided contract before you resolve it. The docs describe the system and are not standing permission to build it.

- **Why:** unrequested changes are hard to review and can override a decision.
- **Enforced by:** review.
- **Applies to:** all changes.

### STD-DOCS-009 An ADR ends with the scenarios that validate it

Every ADR ends with a `## Validation` section: a list of scenarios that would show the decision holds. Each scenario names the test case or evidence record that checks it, or says "Not proven yet" and links the issue that will. Write the proof issues for a slice from these scenarios.

- **Why:** a decision nobody can check drifts from the code without anyone noticing.
- **Enforced by:** `scripts/check-standards.mjs` in `pnpm check` (the section exists and lists at least one scenario), and review.
- **Applies to:** `docs/decisions/`.

### STD-DOCS-010 A proof leaves a dated evidence record

A pull request that proves a slice end to end, or records a manual run, adds an [evidence record](../evidence/README.md) with its date, issue, pull request, commit, setup and result. In the same pull request it updates the [status page](../STATUS.md): the item moves to "What works", or its gaps go under "Not proven yet".

- **Why:** without a dated record of what ran where, nobody can tell what is proven and what only compiles.
- **Enforced by:** `scripts/check-standards.mjs` in `pnpm check` (each record has its fields and the status page links it), and review.
- **Applies to:** `docs/evidence/`, `docs/STATUS.md`, and pull requests that close a "Prove …" issue.

