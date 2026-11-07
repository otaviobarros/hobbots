# UI standards

Rules for how UI code is written and how it must look. The [design specification](../design/ui-ux.md) and the [screen inventory](../design/screens-and-flows.md) define the design. These rules point to them and do not copy them.

### STD-UI-001 Styles use theme tokens only

Take colors, spacing, radii, type and animations from the theme tokens in `apps/web/src/styles.css`: the `@theme` block and the per-theme `data-theme` rules ([themes](../design/themes.md)). Add a token there, with a value for every theme, when the design needs a new value. Components never hold raw hex colors or one-off pixel values, and never check which theme is on.

- **Why:** one token change restyles every screen, and the palette stays consistent.
- **Enforced by:** the token guard, `apps/web/tokens.test.ts`, in `pnpm check`, and review for values it cannot see, such as spacing.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-UI-002 Build on the shared primitives

Build screens from the shadcn and Radix primitives in `packages/ui`. When no primitive fits, add a new one to `packages/ui`, not to the web app.

- **Why:** primitives carry focus, keyboard and ARIA behavior that a custom widget must rebuild.
- **Enforced by:** review.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-UI-003 Every control works by keyboard and has a name

Every interactive element is reachable and usable by keyboard, shows the moonlight focus ring, and has an accessible name. End-to-end tests find elements by role and name, so a missing name fails the test.

- **Why:** Hobbots must work for keyboard and screen-reader users.
- **Enforced by:** Biome `a11y` rules, Playwright role selectors (STD-TEST-004), the axe scan of every screen (STD-TEST-007) and the keyboard-only flows (STD-TEST-008).
- **Applies to:** `apps/web`, `packages/ui`.

### STD-UI-004 Motion is stepped and stops with Reduce motion

Animate only with the stepped `--animate-hb-*` tokens. Every animation stops with Reduce motion: the system's setting, unless the device chose otherwise in Settings › This app. The Reduce motion rules at the end of `apps/web/src/styles.css` do this for CSS animations, and the `motion-reduce:` variant follows the same choice. Motion driven from script checks `motionReduced()` from `apps/web/src/lib/motion.ts`.

- **Why:** stepped timing is part of the pixel style, and some users get sick from motion.
- **Enforced by:** the token guard, `apps/web/tokens.test.ts`, in `pnpm check`, which fails on a literal duration or an animation that is not an `--animate-hb-*` token, and review.
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

### STD-UI-009 Every failure says what went wrong and how to recover

When something fails, tell the user in plain words what went wrong and what they can do next: retry, fix an input, reconnect, or go somewhere else. Never show a dead end, a raw error code or a stack trace. Keep what the user typed. Map each failure the client knows to its own message (STD-I18N-005), and give unknown failures a general message that still offers a way out.

- **Why:** UX is a first-class goal, and a user who knows the next step can recover without help.
- **Enforced by:** review, and end-to-end tests of each flow's failure paths (STD-TEST-004).
- **Applies to:** `apps/web`, `packages/ui`.

### STD-UI-010 Only primitives take a className, and only for layout

Feature components in `apps/web` do not accept a `className` prop. The primitives in `packages/ui` accept one, merge it with `cn` and set `data-slot`. A `className` passed to a primitive holds only layout classes: margin, width and height, flex and grid placement, and position. Color, type, padding, border, radius and shadow come from a variant (STD-UI-011).

- ✅ `<Button className="ms-auto" variant="ghost">`
- ❌ `<Button className="bg-rose px-6 text-[13px]">`
- **Why:** a screen that cannot restyle a component cannot drift from the design system.
- **Enforced by:** the frontend check in `pnpm check`. It fails on a `className` passed to a component imported from `@hobbots/ui/components/*` that holds a class other than margin, width and height, flex and grid placement, position, inset, translate, z-index or `hidden`, and on a feature component in `apps/web` whose props have a `className`. It reads the imports, so it knows which elements are primitives. Code that broke the rule when the check was turned on sits in the frontend baseline until its looks move into variants.
- **Applies to:** `apps/web`, `packages/ui`.

### STD-UI-011 Visual variants come from cva

Give a primitive its visual variations through `cva` variants, named after the design system's variants. Do not switch looks with booleans or with class ternaries. A new look is a new variant in `packages/ui`.

- **Why:** every look the app can take is listed in one place, and the design system can review it.
- **Enforced by:** review, and STD-UI-010 for looks passed in from outside.
- **Applies to:** `packages/ui`.

### STD-UI-012 Conditional and joined classes go through cn

When an element's classes depend on a condition, or join a class list with another, build them with `cn` from `@hobbots/ui/lib/utils`. Do not write a ternary, a `&&`, a `+`, a `join` or a template with holes as the `className`. A fixed class list stays a plain string. Inside `cn`, pass the base classes first and each condition as its own argument.

- ✅ `className={cn("rounded-card border px-3", open && "bg-hover")}`
- ✅ `className="flex items-center gap-2"`
- ❌ ``className={`rounded-card border ${open ? "bg-hover" : ""}`}``
- ❌ `className={open ? "flex gap-2" : "flex gap-3"}`
- **Why:** `cn` merges classes that conflict, so the class a condition adds wins over the base one, rather than whichever the stylesheet happens to list last. Hand-built strings also invite classes pieced together at run time, such as `bg-${tone}`, which Tailwind cannot find in the source and never generates. One way of composing keeps each condition readable as its own argument.
- **Enforced by:** the frontend check in `pnpm check`. It fails on a `className` attribute whose value is a template with holes, a conditional, a `&&` or `||`, a `+` or a `.join(...)`. `cn(...) || undefined`, which leaves the attribute off when no class is left, passes.
- **Applies to:** `apps/web`, `packages/ui`.
