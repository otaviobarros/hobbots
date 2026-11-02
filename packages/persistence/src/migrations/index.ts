import type { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import initial from "./0001_initial.ts";
import hobLook from "./0002_hob_look.ts";
import lookSeedBigint from "./0003_look_seed_bigint.ts";
import installationSetup from "./0004_installation_setup.ts";
import hobBrain from "./0005_hob_brain.ts";
import connectedProviders from "./0006_connected_providers.ts";
import hobConfigVersions from "./0007_hob_config_versions.ts";
import hobStatus from "./0008_hob_status.ts";
import hobRetiredAt from "./0009_hob_retired_at.ts";
import hobRoles from "./0010_hob_roles.ts";
import searchIndex from "./0011_search_index.ts";
import eventJournal from "./0012_event_journal.ts";
import hobIdentity from "./0013_hob_identity.ts";
import hobTone from "./0014_hob_tone.ts";
import hobPolicy from "./0015_hob_policy.ts";
import messageResetsAt from "./0016_message_resets_at.ts";
import messageSteps from "./0017_message_steps.ts";
import approvalRequests from "./0018_approval_requests.ts";
import approvalOnceOnly from "./0019_approval_once_only.ts";
import threadBrains from "./0020_thread_brains.ts";
import hobSignCommits from "./0021_hob_sign_commits.ts";
import approvalGrants from "./0022_approval_grants.ts";
import threadArchivedAt from "./0023_thread_archived_at.ts";
import tasksAndQuests from "./0024_tasks_and_quests.ts";
import taskToolCalls from "./0025_task_tool_calls.ts";
import backpackItems from "./0026_backpack_items.ts";
import githubCharm from "./0027_github_charm.ts";
import charmCalls from "./0028_charm_calls.ts";
import backpackBlockers from "./0029_backpack_blockers.ts";
import memberApprovals from "./0030_member_approvals.ts";
import taskNotes from "./0031_task_notes.ts";

/**
 * Every migration, keyed `<id>_<name>`. Effect's Migrator records applied ids and runs only
 * pending ones in id order. Add a new file per change; never edit a merged migration.
 * An explicit list (rather than a glob) works under tsx, Vitest and the bundled Electron app.
 */
export const migrations: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>> = {
  "0001_initial": initial,
  "0002_hob_look": hobLook,
  "0003_look_seed_bigint": lookSeedBigint,
  "0004_installation_setup": installationSetup,
  "0005_hob_brain": hobBrain,
  "0006_connected_providers": connectedProviders,
  "0007_hob_config_versions": hobConfigVersions,
  "0008_hob_status": hobStatus,
  "0009_hob_retired_at": hobRetiredAt,
  "0010_hob_roles": hobRoles,
  "0011_search_index": searchIndex,
  "0012_event_journal": eventJournal,
  "0013_hob_identity": hobIdentity,
  "0014_hob_tone": hobTone,
  "0015_hob_policy": hobPolicy,
  "0016_message_resets_at": messageResetsAt,
  "0017_message_steps": messageSteps,
  "0018_approval_requests": approvalRequests,
  "0019_approval_once_only": approvalOnceOnly,
  "0020_thread_brains": threadBrains,
  "0021_hob_sign_commits": hobSignCommits,
  "0022_approval_grants": approvalGrants,
  "0023_thread_archived_at": threadArchivedAt,
  "0024_tasks_and_quests": tasksAndQuests,
  "0025_task_tool_calls": taskToolCalls,
  "0026_backpack_items": backpackItems,
  "0027_github_charm": githubCharm,
  "0028_charm_calls": charmCalls,
  "0029_backpack_blockers": backpackBlockers,
  "0030_member_approvals": memberApprovals,
  "0031_task_notes": taskNotes,
};
