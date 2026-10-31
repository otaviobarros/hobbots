# UI standards

Rules for how UI code is written and how it must look. The [design specification](../design/ui-ux.md) and the [screen inventory](../design/screens-and-flows.md) define the design. These rules point to them and do not copy them.

### STD-UI-001 Styles use theme tokens only

Take colors, spacing, radii, type and animations from the theme tokens in the `@theme` block of `apps/web/src/styles.css`. Add a token there when the design needs a new value. Components never hold raw hex colors or one-off pixel values.

- **Why:** one token change restyles every screen, and the palette stays consistent.
- **Enforced by:** review.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-UI-002 Build on the shared primitives

Build screens from the shadcn and Radix primitives in `packages/ui`. When no primitive fits, add a new one to `packages/ui`, not to the web app.

- **Why:** primitives carry focus, keyboard and ARIA behavior that a custom widget must rebuild.
- **Enforced by:** review.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-UI-003 Every control works by keyboard and has a name

Every interactive element is reachable and usable by keyboard, shows the moonlight focus ring, and has an accessible name. End-to-end tests find elements by role and name, so a missing name fails the test.

- **Why:** Hobbots must work for keyboard and screen-reader users.
- **Enforced by:** Biome `a11y` rules and Playwright role selectors (STD-TEST-004).
- **Applies to:** `apps/web`, `packages/ui`.

### STD-UI-004 Motion is stepped and stops with Reduce motion

Animate only with the stepped `--animate-hb-*` tokens. Every animation stops when the system asks for reduced motion. The `prefers-reduced-motion` block in `apps/web/src/styles.css` does this for CSS animations. Motion driven from script checks the same media query.

- **Why:** stepped timing is part of the pixel style, and some users get sick from motion.
- **Enforced by:** review.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-UI-005 Screens match the design specification

Every screen matches the [design specification](../design/ui-ux.md). It defines the Home landing page and the chat workspace with Quest, Inbox and Workshop tabs. It also sets the night palette, Atkinson Hyperlegible Next for reading text and Pixelify Sans for headings. A UI change also updates the design specification when it changes the design.

- **Why:** the specification is the single description of the product's look and behavior. See [ADR 008](../decisions/008-design.md).
- **Enforced by:** review.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-UI-006 Selection uses a fill, never a left-edge accent

Show selection with a fill. No element gets a decorative colored border on its left edge.

- **Why:** the design rejects left-edge accents everywhere, and they keep coming back in generated UI.
- **Enforced by:** review.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-UI-007 The UI calls agents hobs

User-facing text calls an agent a "hob". Code may use `agent` where it names the domain entity.

- **Why:** "hob" is the product's word, and the [glossary](../product/glossary.md) defines it.
- **Enforced by:** review.
- **Applies to:** user-facing copy.

### STD-UI-008 Durable records drive every status

Every status shown to the user comes from a durable server record. Text from a model never sets a status.

- **Why:** a model can claim success that did not happen.
- **Enforced by:** review.
- **Applies to:** `apps/web`, `apps/server`.
