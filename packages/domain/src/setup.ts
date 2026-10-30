import { Schema } from "effect";
import { RuntimeKind } from "./agent.ts";

/** The onboarding safety presets (ADR 008). Balanced is Trusted Workspace and the default (ADR 003). */
export const SafetyPreset = Schema.Literals(["careful", "balanced", "trusting"]);
export type SafetyPreset = typeof SafetyPreset.Type;

/** What the installation has settled during first-run setup. */
export class InstallationSetup extends Schema.Class<InstallationSetup>("InstallationSetup")({
  completed: Schema.Boolean,
  safetyPreset: SafetyPreset,
  /** Folders the hobs may work in, in the order the user added them. */
  approvedFolders: Schema.Array(Schema.String),
  /** Providers the user chose to connect, in the order they connected them. */
  connectedProviders: Schema.Array(RuntimeKind),
}) {}
