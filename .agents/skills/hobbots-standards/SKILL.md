---
name: hobbots-standards
description: Hobbots engineering standards with STD rule IDs. Use when planning, writing or reviewing code, tests or docs in this repository, or when adding or changing a rule.
---

# Hobbots standards

The rules live in `docs/standards/`. The index is `docs/standards/README.md`.

## Apply the rules to a change

1. Find the areas the change touches in the prefix table of `docs/standards/README.md`. A component change touches at least `STD-REACT`, `STD-UI` and `STD-I18N`. A backend change touches at least `STD-ARCH`, `STD-EFFECT` and `STD-DUP`. Every change that adds code touches `STD-DUP`: before writing a mechanism of your own, check what the installed libraries provide (STD-DUP-007).
2. Read each of those area files in full.
3. Apply every rule in them. The step is done when you can say, for each rule, that the change follows it or that it does not apply.
4. Cite the IDs you applied in the plan or the review, for example "follows STD-REACT-001". A review finding names the rule it breaks.

## Add or change a rule

1. Edit the rule in its area file and its row in the index together. The format and numbering rules are in "Change a rule" in `docs/standards/README.md`.
2. Run `node scripts/check-standards.mjs`. It passes when the index and the area files agree.
