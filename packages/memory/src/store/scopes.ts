import { createHash } from "node:crypto";
import { AgentId, type MemoryAuthor, type MemoryScope } from "@hobbots/domain";
import { ROOT_USERNAME } from "../engine/config.ts";
import { MEMORY_WORKSPACE } from "../engine/engine.ts";

/** Where a scope's pages live in ai-memory: a project inside a workspace. */
export interface EngineProject {
  readonly workspace: string;
  readonly project: string;
}

/** ai-memory keeps the cross-project `_global` scope in its own `default` workspace. */
const GLOBAL: EngineProject = { workspace: "default", project: "_global" };

const HOB_PREFIX = "hob-";

/**
 * The ai-memory project that holds a scope (ADR 028): `hob-<hob id>` for a hob's own memory, and
 * `repo-<identity>` for a project, made of letters, digits, `.` and `-` and ending with a short hash
 * of the whole identity, so two identities that read alike never share a project. `Everyone` is
 * ai-memory's reserved `_global`.
 */
export const engineProjectOf = (scope: MemoryScope): EngineProject => {
  switch (scope._tag) {
    case "Hob":
      return { workspace: MEMORY_WORKSPACE, project: `${HOB_PREFIX}${scope.agentId}` };
    case "Project": {
      const readable = scope.identity
        .replace(/[^a-z0-9.-]+/g, "-")
        .slice(0, 80)
        .replace(/^-|-$/g, "");
      const hash = createHash("sha256").update(scope.identity).digest("hex").slice(0, 10);
      return { workspace: MEMORY_WORKSPACE, project: `repo-${readable}-${hash}` };
    }
    case "Everyone":
      return GLOBAL;
  }
};

/** The name a hob's calls assert to ai-memory, so each page and audit row names the hob. */
export const engineActorOf = (agentId: AgentId): string => `${HOB_PREFIX}${agentId}`;

/** Who wrote a version, from the `last_modified_by` username ai-memory stamps in its frontmatter. */
export const authorOfUsername = (username: string | undefined): MemoryAuthor | null => {
  if (username === ROOT_USERNAME) return { _tag: "You" };
  if (username?.startsWith(HOB_PREFIX))
    return { _tag: "Hob", agentId: AgentId.make(username.slice(HOB_PREFIX.length)) };
  return null;
};
