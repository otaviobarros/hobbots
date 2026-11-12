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
import devices from "./0031_devices.ts";
import taskNotes from "./0032_task_notes.ts";
import withdrawnQuestions from "./0033_withdrawn_questions.ts";
import hobGitHubApps from "./0034_hob_github_apps.ts";
import taskGrants from "./0035_task_grants.ts";
import attemptActivity from "./0036_attempt_activity.ts";
import replyUsage from "./0037_reply_usage.ts";
import backupRestore from "./0038_backup_restore.ts";
import taskToolRefusals from "./0039_task_tool_refusals.ts";
import approvalDeciders from "./0040_approval_deciders.ts";
import checkpointAboutTask from "./0041_checkpoint_about_task.ts";
import leadMessages from "./0042_lead_messages.ts";
import cancelRequests from "./0043_cancel_requests.ts";
import questionAnswerers from "./0044_question_answerers.ts";
import callKeyScopes from "./0045_call_key_scopes.ts";
import stateChecks from "./0046_state_checks.ts";
import versionedName from "./0047_versioned_name.ts";
import historyReads from "./0048_history_reads.ts";
import threadPinnedAt from "./0049_thread_pinned_at.ts";
import attemptSteps from "./0050_attempt_steps.ts";
import steerReceipts from "./0051_steer_receipts.ts";
import checkpointDetail from "./0052_checkpoint_detail.ts";
import threadReads from "./0053_thread_reads.ts";
import questionOptions from "./0054_question_options.ts";
import memorySaves from "./0055_memory_saves.ts";
import memoryCapture from "./0056_memory_capture.ts";
import hubQuestions from "./0057_hub_questions.ts";
import memorySaveUndo from "./0058_memory_save_undo.ts";
import memoryShares from "./0059_memory_shares.ts";
import attemptTurnUsage from "./0060_attempt_turn_usage.ts";
import memoryCaptureSessionIds from "./0061_memory_capture_session_ids.ts";
import quietReplies from "./0062_quiet_replies.ts";
import commitIdentity from "./0063_commit_identity.ts";
import memorySaveAttempt from "./0064_memory_save_attempt.ts";
import skills from "./0065_skills.ts";
import skillRollouts from "./0066_skill_rollouts.ts";
import messageSkills from "./0067_message_skills.ts";
import messageSkillsUsed from "./0068_message_skills_used.ts";
import skillUses from "./0069_skill_uses.ts";
import skillProposals from "./0070_skill_proposals.ts";
import charmOperations from "./0071_charm_operations.ts";
import restoreSkillMoves from "./0072_restore_skill_moves.ts";
import skillSets from "./0073_skill_sets.ts";
import milestoneReachedBy from "./0074_milestone_reached_by.ts";
import charmCallValues from "./0075_charm_call_values.ts";
import charmGrants from "./0076_charm_grants.ts";
import skillUpdates from "./0077_skill_updates.ts";
import hubQuestionCodes from "./0078_hub_question_codes.ts";
import hobVisibility from "./0079_hob_visibility.ts";
import hobGoodAt from "./0080_hob_good_at.ts";
import codingSetupDismissals from "./0081_coding_setup_dismissals.ts";
import hobActors from "./0082_hob_actors.ts";
import summoning from "./0083_summoning.ts";
import threadSkillTrial from "./0084_thread_skill_trial.ts";
import hobStatusChanges from "./0085_hob_status_changes.ts";
import webFoundUrls from "./0086_web_found_urls.ts";
import skillRepositoryOffers from "./0087_skill_repository_offers.ts";
import hobRetiring from "./0088_hob_retiring.ts";
import hobProposals from "./0089_hob_proposals.ts";
import webUsage from "./0090_web_usage.ts";
import attemptReadWeb from "./0091_attempt_read_web.ts";
import webScreens from "./0092_web_screens.ts";
import hobGitHubAppOrigin from "./0093_hob_github_app_origin.ts";
import memoryVersionAuthors from "./0094_memory_version_authors.ts";
import threadKinds from "./0095_thread_kinds.ts";
import memoryCapturePrivateThreads from "./0096_memory_capture_private_threads.ts";
import carriedOver from "./0097_carried_over.ts";
import claims from "./0098_claims.ts";
import chapters from "./0099_chapters.ts";
import projectorCursors from "./0100_projector_cursors.ts";
import records from "./0101_records.ts";
import briefs from "./0102_briefs.ts";
import questSummaries from "./0103_quest_summaries.ts";
import campSuggestions from "./0104_camp_suggestions.ts";
import artifactReviews from "./0105_artifact_reviews.ts";
import findIndex from "./0106_find_index.ts";
import messagePins from "./0107_message_pins.ts";
import artifactVersions from "./0108_artifact_versions.ts";
import questStops from "./0110_quest_stops.ts";

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
  "0031_devices": devices,
  "0032_task_notes": taskNotes,
  "0033_withdrawn_questions": withdrawnQuestions,
  "0034_hob_github_apps": hobGitHubApps,
  "0035_task_grants": taskGrants,
  "0036_attempt_activity": attemptActivity,
  "0037_reply_usage": replyUsage,
  "0038_backup_restore": backupRestore,
  "0039_task_tool_refusals": taskToolRefusals,
  "0040_approval_deciders": approvalDeciders,
  "0041_checkpoint_about_task": checkpointAboutTask,
  "0042_lead_messages": leadMessages,
  "0043_cancel_requests": cancelRequests,
  "0044_question_answerers": questionAnswerers,
  "0045_call_key_scopes": callKeyScopes,
  "0046_state_checks": stateChecks,
  "0047_versioned_name": versionedName,
  "0048_history_reads": historyReads,
  "0049_thread_pinned_at": threadPinnedAt,
  "0050_attempt_steps": attemptSteps,
  "0051_steer_receipts": steerReceipts,
  "0052_checkpoint_detail": checkpointDetail,
  "0053_thread_reads": threadReads,
  "0054_question_options": questionOptions,
  "0055_memory_saves": memorySaves,
  "0056_memory_capture": memoryCapture,
  "0057_hub_questions": hubQuestions,
  "0058_memory_save_undo": memorySaveUndo,
  "0059_memory_shares": memoryShares,
  "0060_attempt_turn_usage": attemptTurnUsage,
  "0061_memory_capture_session_ids": memoryCaptureSessionIds,
  "0062_quiet_replies": quietReplies,
  "0063_commit_identity": commitIdentity,
  "0064_memory_save_attempt": memorySaveAttempt,
  "0065_skills": skills,
  "0066_skill_rollouts": skillRollouts,
  "0067_message_skills": messageSkills,
  "0068_message_skills_used": messageSkillsUsed,
  "0069_skill_uses": skillUses,
  "0070_skill_proposals": skillProposals,
  "0071_charm_operations": charmOperations,
  "0072_restore_skill_moves": restoreSkillMoves,
  "0073_skill_sets": skillSets,
  "0074_milestone_reached_by": milestoneReachedBy,
  "0075_charm_call_values": charmCallValues,
  "0076_charm_grants": charmGrants,
  "0077_skill_updates": skillUpdates,
  "0078_hub_question_codes": hubQuestionCodes,
  "0079_hob_visibility": hobVisibility,
  "0080_hob_good_at": hobGoodAt,
  "0081_coding_setup_dismissals": codingSetupDismissals,
  "0082_hob_actors": hobActors,
  "0083_summoning": summoning,
  "0084_thread_skill_trial": threadSkillTrial,
  "0085_hob_status_changes": hobStatusChanges,
  "0086_web_found_urls": webFoundUrls,
  "0087_skill_repository_offers": skillRepositoryOffers,
  "0088_hob_retiring": hobRetiring,
  "0089_hob_proposals": hobProposals,
  "0090_web_usage": webUsage,
  "0091_attempt_read_web": attemptReadWeb,
  "0092_web_screens": webScreens,
  "0093_hob_github_app_origin": hobGitHubAppOrigin,
  "0094_memory_version_authors": memoryVersionAuthors,
  "0095_thread_kinds": threadKinds,
  "0096_memory_capture_private_threads": memoryCapturePrivateThreads,
  "0097_carried_over": carriedOver,
  "0098_claims": claims,
  "0099_chapters": chapters,
  "0100_projector_cursors": projectorCursors,
  "0101_records": records,
  "0102_briefs": briefs,
  "0103_quest_summaries": questSummaries,
  "0104_camp_suggestions": campSuggestions,
  "0105_artifact_reviews": artifactReviews,
  "0106_find_index": findIndex,
  "0107_message_pins": messagePins,
  "0108_artifact_versions": artifactVersions,
  "0110_quest_stops": questStops,
};
