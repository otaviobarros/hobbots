# Docs

The docs hold the product, the contracts, the decisions and the standards. These rules add to the root [AGENTS.md](../AGENTS.md).

## Code Review Rules

- Decided choices change only through an ADR or an amendment to one (STD-DOCS-001).
- A contract in `docs/architecture/` says what the code does. A contract change that the code does not back, or a code change the contract no longer describes, is P1 (STD-DOCS-002).
- A standards rule changes in its area file and its index row together, and an ID is never reused or renumbered. [The standards README](standards/README.md) has the steps.
- Docs link only public sources and hold no secrets or private file contents (STD-DOCS-003).
- A proof leaves a dated evidence record that the status page links (STD-DOCS-010).
- UI words and code names follow the glossary (STD-DOCS-011).
- Do not flag wording, tone or sentence length. Docs use short, plain sentences (STD-DOCS-007), but style alone is not a finding.
