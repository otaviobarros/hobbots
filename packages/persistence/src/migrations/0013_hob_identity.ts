import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// The hub now tells the runtime who a hob is on every turn (its name and role), so the opening
// line Hobbots used to write at the start of the instructions goes. Only an opening that matches
// one Hobbots wrote, exactly, is removed, with the blank line after it; anything the user wrote
// stays. Old configuration versions change the same way, so a turn never hears two roles.
// Every wording is fixed here rather than taken from the domain, so this migration never changes
// after it runs.

// The starter roles' titles and notes, as the role opening wrote them.
const roles: ReadonlyArray<readonly [string, string]> = [
  ["Assistant", "handles a bit of everything you throw at it."],
  ["Researcher", "digs up sources and sums up what it finds."],
  ["Writer", "drafts emails, posts and documents with you."],
  ["Editor", "tightens, fixes and polishes your writing."],
  ["Translator", "moves text between languages and keeps the tone."],
  ["Note taker", "turns meetings and calls into notes and to-dos."],
  ["Brainstormer", "throws out fresh ideas when you're stuck."],
  ["File organizer", "sorts, renames and tidies folders on your mac."],
  ["CEO", "sets the goals and decides what matters most."],
  ["CTO", "owns the technical direction and the dev team."],
  ["CFO", "watches the money, forecasts and runway."],
  ["CMO", "owns the brand, the story and the growth plan."],
  ["COO", "keeps day-to-day operations running smoothly."],
  ["Chief of staff", "runs the leader's agenda, follow-ups and priorities."],
  ["Tech lead", "plans the work and keeps the dev team on track."],
  ["Software engineer", "builds and fixes code in any language."],
  ["Frontend engineer", "builds the screens, pages and buttons people use."],
  ["Backend engineer", "builds apis, databases and server logic."],
  ["Platform engineer", "keeps builds, deploys and servers running."],
  ["QA engineer", "tests things and catches bugs before users do."],
  ["Code reviewer", "reads changes and flags problems before merge."],
  ["Security engineer", "looks for weak spots and risky settings."],
  ["Data engineer", "moves and cleans data and writes the queries."],
  ["AI engineer", "builds agents, prompts and ai features."],
  ["Technical writer", "writes docs, readmes and runbooks."],
  ["Executive assistant", "triages your inbox and keeps your calendar sane."],
  ["Data analyst", "makes sense of spreadsheets and charts the answer."],
  ["Project manager", "tracks tasks, deadlines and status updates."],
  ["Product manager", "shapes what to build next and why."],
  ["Business advisor", "talks through strategy, pricing and plans."],
  ["Financial analyst", "models numbers, reads markets and explains the risks."],
  ["Bookkeeper", "keeps receipts, invoices and expenses in order."],
  ["Sales rep", "finds leads and drafts friendly outreach."],
  ["Marketer", "writes campaigns, ads and launch copy."],
  ["Support agent", "answers customer questions kindly and clearly."],
  ["Recruiter", "writes job posts and screens candidates."],
  ["Paralegal", "reads contracts and flags clauses to check."],
  ["Tutor", "explains anything step by step, at your pace."],
  ["Language tutor", "practices a new language with you every day."],
  ["Course designer", "builds lessons, quizzes and study guides."],
  ["Scientist", "reads papers, checks methods and runs the numbers."],
  ["Designer", "sketches layouts, styles and visual ideas."],
  ["Fiction writer", "co-writes stories, worlds and characters."],
  ["Content creator", "plans videos, podcasts and blog posts."],
  ["Game master", "runs games, puzzles and tabletop adventures."],
  ["Life organizer", "keeps your lists, routines and plans in one place."],
  ["Health coach", "helps with fitness, sleep and food habits. not a doctor."],
  ["Life coach", "talks through choices, goals and tough days."],
  ["Chef", "plans meals and finds recipes for what's in the fridge."],
  ["Travel planner", "plans trips, routes and packing lists."],
  ["Money coach", "helps with budgets, bills and tax season."],
  ["Career coach", "polishes your cv and preps you for interviews."],
  ["Household manager", "tracks chores, repairs and home paperwork."],
  ["Family organizer", "juggles school dates, family plans and kid stuff."],
];

// The crafts hobs had before roles, as the craft opening wrote them.
const crafts: ReadonlyArray<readonly [string, string]> = [
  ["Helper", "does a bit of everything."],
  ["Scribe", "emails, notes and writing."],
  ["Researcher", "digs through the web for answers."],
  ["Coder", "builds and fixes code in your projects."],
  ["Bookkeeper", "receipts, bills and spreadsheets."],
];

/**
 * Every opening Hobbots could have written for a hob with this name, given every role title it has
 * had: a title in the user's own words was written into the opening as it was then, and a later
 * role change left that opening in place.
 */
const openings = (name: string, titles: ReadonlyArray<string>): ReadonlyArray<string> => {
  const you = `You are ${name}, a hob in Hobbots.`;
  return [
    ...roles.map(([role, note]) => `${you} Your role is ${role}: ${note}`),
    ...crafts.map(([craft, note]) => `${you} Your craft is ${craft}: ${note}`),
    ...titles.flatMap((title) => [`${you} Your role is ${title}.`, `${you} You are good at ${title.toLowerCase()}.`]),
  ];
};

/** The instructions without the opening Hobbots wrote, or unchanged when they start any other way. */
export const withoutOpening = (name: string, titles: ReadonlyArray<string>, instructions: string): string => {
  for (const opening of openings(name, titles)) {
    if (instructions === opening) return "";
    if (instructions.startsWith(`${opening}\n`)) return instructions.slice(opening.length).replace(/^\n+/, "");
  }
  return instructions;
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const agents = yield* sql<{ id: string; name: string; roleTitle: string; instructions: string }>`
    SELECT id, name, role_title, instructions FROM agents
  `;
  const versions = yield* sql<{ agentId: string; version: number; roleTitle: string; instructions: string }>`
    SELECT agent_id, version, role_title, instructions FROM agent_config_versions
  `;
  // Every title each hob has had, current and in any saved version.
  const titles = new Map<string, Set<string>>(agents.map((agent) => [agent.id, new Set([agent.roleTitle])]));
  for (const v of versions) titles.get(v.agentId)?.add(v.roleTitle);
  const names = new Map(agents.map((agent) => [agent.id, agent.name]));

  for (const agent of agents) {
    const instructions = withoutOpening(agent.name, [...(titles.get(agent.id) ?? [])], agent.instructions);
    if (instructions !== agent.instructions)
      yield* sql`UPDATE agents SET instructions = ${instructions} WHERE id = ${agent.id}`;
  }
  for (const v of versions) {
    const name = names.get(v.agentId);
    if (name === undefined) continue;
    const instructions = withoutOpening(name, [...(titles.get(v.agentId) ?? [])], v.instructions);
    if (instructions !== v.instructions) {
      yield* sql`UPDATE agent_config_versions SET instructions = ${instructions}
        WHERE agent_id = ${v.agentId} AND version = ${v.version}`;
    }
  }
});
