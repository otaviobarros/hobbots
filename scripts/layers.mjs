// The package layers and the check that each package declares only what its layer allows (STD-ARCH-001).

// The source of truth for package layers. A new workspace package must be added here.
// `may` lists the workspace packages a package may depend on. `external`, when present, lists the only
// other packages it may declare as runtime dependencies.
export const layers = {
  // Domain code is pure and imports only effect (STD-ARCH-002).
  "@hobbots/domain": { layer: "domain", may: [], external: ["effect"] },
  "@hobbots/api": { layer: "contract", may: ["@hobbots/domain"] },
  "@hobbots/agents": { layer: "application", may: ["@hobbots/domain", "@hobbots/api"] },
  // Tasks, Quests and delegation, as use cases over the ports in agents (ADR 018).
  "@hobbots/orchestration": { layer: "application", may: ["@hobbots/domain", "@hobbots/agents"] },
  "@hobbots/permissions": { layer: "adapter", may: ["@hobbots/domain"] },
  "@hobbots/persistence": { layer: "adapter", may: ["@hobbots/domain", "@hobbots/api", "@hobbots/agents"] },
  "@hobbots/runtimes": {
    layer: "adapter",
    // The runtime adapters ask the policy engine before each tool call (ADR 014).
    may: ["@hobbots/domain", "@hobbots/api", "@hobbots/agents", "@hobbots/permissions"],
  },
  // Pixel art that the app and the site both draw. Plain data and pure functions.
  "@hobbots/art": { layer: "adapter", may: ["@hobbots/domain"] },
  "@hobbots/ui": { layer: "adapter", may: ["@hobbots/art"] },
  "@hobbots/server": {
    layer: "composition",
    may: [
      "@hobbots/domain",
      "@hobbots/api",
      "@hobbots/agents",
      "@hobbots/orchestration",
      "@hobbots/permissions",
      "@hobbots/persistence",
      "@hobbots/runtimes",
    ],
  },
  "@hobbots/web": { layer: "composition", may: ["@hobbots/domain", "@hobbots/api", "@hobbots/art", "@hobbots/ui"] },
  // The public website stands apart from the product and shares only its pixel art.
  "@hobbots/site": { layer: "composition", may: ["@hobbots/art"] },
  // The desktop app starts the bundled server and reads its installation file.
  "@hobbots/desktop": { layer: "composition", may: ["@hobbots/domain", "@hobbots/api", "@hobbots/server"] },
};

const WORKSPACE = "@hobbots/";

// Returns one message for each rule that the packages break. `packages` maps a location to its package.json.
export const check = (packages, table = layers) => {
  const errors = [];
  const seen = new Set();
  for (const [location, pkg] of Object.entries(packages)) {
    seen.add(pkg.name);
    const rule = table[pkg.name];
    if (!rule) {
      errors.push(`${pkg.name} (${location}) has no layer in scripts/layers.mjs`);
      continue;
    }
    const declared = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    for (const dep of Object.keys(declared).filter((name) => name.startsWith(WORKSPACE))) {
      if (!rule.may.includes(dep)) {
        errors.push(`${pkg.name} (${rule.layer}) must not depend on ${dep} (${table[dep]?.layer ?? "unknown"})`);
      }
    }
    if (!rule.external) continue;
    const runtime = { ...pkg.dependencies, ...pkg.peerDependencies };
    for (const dep of Object.keys(runtime).filter((name) => !name.startsWith(WORKSPACE))) {
      if (!rule.external.includes(dep)) errors.push(`${pkg.name} (${rule.layer}) must not depend on ${dep}`);
    }
  }
  for (const name of Object.keys(table)) {
    if (!seen.has(name)) errors.push(`${name} is listed in scripts/layers.mjs but no package has that name`);
  }
  return errors;
};
