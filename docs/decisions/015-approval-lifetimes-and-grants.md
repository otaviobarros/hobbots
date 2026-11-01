# ADR 015 — Approval lifetimes and standing grants

Status: **Accepted.** Refines the [permissions contract](../architecture/permissions.md) and the approvals of [ADR 014](014-tool-policy-and-enforcement.md#asking-the-user) for Slice 8.

## Context

Slice 7 lets the user approve one call at a time: Approve once or Deny. PE-007 asks for three lifetimes: **just this once**, **for this Quest** and **always for this site**. The permissions contract names them but leaves open:

- what a "site" is for each operation;
- how a saved grant matches a later call, and how it can stay no broader than what the user saw;
- where a grant sits among Never, Deny, Ask and per-hob overrides;
- which actions can never be granted, how long a pending request stays open, and what policy changes and revocation do to grants and running turns.

Four tools that already save approvals informed the choices:

- **Claude Code** saves "Yes, and don't ask again" as permission rules, such as `Bash(npm test *)` or `WebFetch(domain:example.com)`. Rules are evaluated deny, then ask, then allow. The first match wins whatever its specificity, so an allow rule cannot carve an exception out of a deny or ask rule. A compound command runs without a prompt only when every subcommand is allowed. Approving one saves a rule per subcommand. The prompt offers "don't ask again" only when it can show everything the saved rule would allow. `/permissions` lists every rule with the file it came from, and a change applies from the next tool call. A file edit approval lasts only until the session ends. ([Configure permissions](https://code.claude.com/docs/en/permissions))
- **Codex** answers an approval with approve, approve for the session, approve with a proposed policy amendment (a prefix rule saved for later sessions), a saved network rule per host, or deny. Its prefix rules match a command's leading tokens with `allow`, `prompt` or `forbidden`, and the strictest match wins. ([`ReviewDecision`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs), [execpolicy](https://github.com/openai/codex/blob/main/codex-rs/execpolicy/README.md))
- **GitHub Copilot CLI** approves a tool once or for the rest of the session, takes `--allow-tool` and `--deny-tool` patterns at start, remembers exact path approvals without granting their parent folder, and clears approvals with `/reset-allowed-tools`. ([changelog](https://github.com/github/copilot-cli/blob/main/changelog.md))
- **LangChain's Agent Inbox** shows each interrupt with its action and arguments, and the interrupt itself declares which answers it allows: accept, edit, respond or ignore. ([agent-inbox](https://github.com/langchain-ai/agent-inbox))

What the three coding tools share: a saved approval is a visible rule; deny beats allow whatever the specificity; a rule is offered only when it covers no more than the prompt showed; saved rules can be listed and removed. The Agent Inbox adds one idea: the request decides which answers it offers.

## Decision

### Lifetimes

A decision on a pending request names one of three lifetimes, or denies it.

| Lifetime | On the card | What it saves | Ends when |
| --- | --- | --- | --- |
| Just this once | Allow once | Nothing beyond this request (ADR 014) | The call runs or is refused |
| For this Quest | This Quest | A grant for the rule, bound to the request's Quest | The Quest ends, or the grant is revoked |
| Always for this site | Always | A standing grant for the rule | The grant is revoked |

- **A grant belongs to one hob.** It never applies to another hob, and delegation cannot pass it on: a child hob asks on its own (PE-004).
- **For this Quest is stored now and offered once Quests exist** (Slice 9). The grant table has a nullable Quest from the start. Until then the card hides This Quest, and the Inbox groups requests by hob and thread instead of by Quest.
- **Always has no time limit.** A standing grant lasts until the user removes it, or until a change takes away the authority it relied on (see [Revocation](#revocation-and-policy-changes)). Every grant records when it was last used, so stale rules are easy to spot and remove. The table keeps a nullable expiry for a later time-boxed lifetime.
- **Deny saves nothing.** A standing "never" is a per-hob override set to Never in the Permissions tab, not an approval lifetime.

### What a site is

A grant names one hob, one operation and one site. The site depends on the operation.

| Operation | Site | Default rule on the card | The user can narrow it to |
| --- | --- | --- | --- |
| Create and edit files, Delete files, Read files | A folder inside the hob's folders | The folder that directly holds each of the call's files | The exact files of the call |
| Run commands, Local Git | A command in a folder | The exact command, in the folder it runs in | — |
| Use the web | A host | The exact host | — |
| A Charm action, such as Push | The action and its target | Push to this remote and branch | — |

- **Paths** are canonical, as in [ADR 014](014-tool-policy-and-enforcement.md#folders). A folder rule covers the files directly in its folder, not its subfolders. A call with files in several folders saves one rule per folder. A call whose target is itself a folder, such as deleting a folder, saves a rule for that folder only, never for the folder above it. A folder rule never reaches outside the hob's folders, since that is Deny, and a rule for changes never covers the protected Git paths, since changing them is Deny.
- **Commands** match word by word, and only literal commands can be granted. A word is literal when the shell would pass it exactly as written: no unquoted `*`, `?`, `[`, `{` or `~`, and no `$` or backtick outside single quotes, in any word, not only the program. The rule is the command's list of literal words, after their quotes are removed. A call matches only when it is literal too and its words are the same. So `rm '*.tmp'` (one file named `*.tmp`) can be granted, while `rm *.tmp` and `rm "$FILE"` cannot, and neither ever matches the first one's rule. `pnpm test` matches `pnpm test` and nothing else: not `pnpm test --watch`, not `pnpm install`, and not `pnpm test && curl …`. A compound command (`&&`, `||`, `;`, `|`, a newline) runs without asking only when each subcommand is allowed by policy or matches a grant; Approving it with Always saves one rule per subcommand that asked. The command's folder is its canonical working folder, and the rule covers exactly that folder, not the folders below it.
- **A command rule approves the command's words, not what they run.** `pnpm test` runs whatever the folder's `package.json` says, and a hob that may edit that file can change it. The card says so for package scripts and similar runners ("runs this folder's test script"), so the user knows what Always covers.
- **A command the hub cannot read fully offers no Always and no This Quest.** That covers every command with a word that is not literal (globs, variables, `~`, command or process substitution), leading `VAR=` assignments, redirections, here-documents, `cd` and `pushd` (they change the folder the rest runs in), `eval`, `sh -c` and other shells, and wrappers such as `xargs`, `env`, `sudo`, `exec` and `watch`. The user can still allow it once. This follows Claude Code: a rule is offered only when the card can show everything it would allow.
- **Hosts** are compared lowercase, with a trailing dot removed and international names in their ASCII form. The rule is the exact host, with no subdomains. It covers both the hob's web tools and its commands' connections through the sandbox proxy, since both are Use the web. The proxy does not know which turn asked, so, as in [ADR 014](014-tool-policy-and-enforcement.md#what-131-verified), a host is reached from a command only when every live turn allows it, by policy or by its own hob's grant. Loopback, link-local and cloud metadata addresses are never reachable, so they are never granted.
- **Push** names the remote as the hub resolved it (its URL) and the branch. A force push or a push to the default branch is high risk and never granted (below).
- **Charm actions** that arrive later declare their own site, such as a Slack channel for Send message. A Charm action that cannot name a site offers once only.

**The rule is shown before it is saved.** Choosing Always (or This Quest) shows the rule in words, such as "Always let Scout run `pnpm test` in ~/Code/hobbots", or "Always let Scout edit files in ~/Code/hobbots/docs". The user saves it as shown or narrows it where the table allows. The decision carries the rule. The hub refuses a rule that does not match the request's own action, or that is broader than the default rule for it, so a client cannot save more than the card offered.

### Precedence

The policy engine decides each call in this order. The first step that answers wins.

1. **Always Deny.** Anything outside the hob's folders, a change to the protected Git paths (they stay readable under the normal policy, as in ADR 014), the Hobbots data folder, a blocked address, and an operation that needs a sandbox that cannot start. No grant reaches these.
2. **Never is final.** When the preset, the hob's override or any thread, Quest or delegated-task restriction answers Never, the call is refused.
3. **High risk asks.** A high-risk action asks, once only, even where the layers answer Allow, as ADR 014 already does for force pushes under Trusting. No grant answers it.
4. **Safety asks stay asks.** An Ask the engine adds for safety, such as a change in a folder too large to search for Git hooks, is never answered by a grant.
5. **Allow runs.** When every layer answers Allow, the call runs.
6. **A narrower Ask still asks.** When the hob's override or any restriction answers Ask for the operation, a grant does not answer it. The user narrowed that scope on purpose.
7. **A live grant allows.** When only the preset answers Ask, a grant for this hob, this operation and a matching site, not revoked, not expired, and bound to this Quest if it names one, answers Allow. The step and the turn's events name the grant, so the reply can say "Allowed by your rule".
8. **Otherwise Ask.** The call pauses for a new approval request.

So Never and Deny always beat a grant, and a grant never turns Deny into Allow. A grant changes only the preset's Ask into Allow, for its own site. The card offers This Quest and Always only for an Ask that a grant could answer.

Today the engine's layered answer keeps the preset's reason when an override or restriction gives the same answer, so it cannot tell where an Ask came from. #212 changes it to report whether any override or restriction answers Ask or Never for the operation, rather than reading the reason code.

### High risk

A high-risk action is offered **once only**, needs the **confirmation check box**, and never offers This Quest or Always. The hub refuses a lifetime other than once for it. The list:

- a force push;
- a push to the remote's default branch;
- a Charm action its Charm marks as high risk, such as paying, sending a message to other people, or deleting data held by the service, once such Charms arrive.

A request that offers once only for another reason is not high risk and needs no check box: no rule can describe it (an unreadable command, a Charm action with no site), or the Ask comes from an override, a restriction or a safety check. The request keeps these apart: `onceOnly` stays the high-risk flag that needs confirming (ADR 014), and a separate `grantable` says whether This Quest and Always are offered.

### How long a request stays open

- A pending request stays open while its turn waits, for at most **24 hours** from when it was asked. The request stores that expiry, and the card and the Inbox show it.
- A turn can end sooner, such as when the runtime's sign-in runs out (about eight hours for a claude.ai login, ADR 014). The request then expires with its turn, as below.
- At expiry the request becomes expired and the call is refused. The hob gets a refusal that says nobody decided in time, and can ask again with fresh facts.
- The expiries of ADR 014 stay: a stopped reply, a retired hob, an aborted call and a server restart expire the request at once.
- An expired request cannot be decided, whatever lifetime the decision names.

### Revocation and policy changes

- **The user removes a grant** from Inbox History or Settings › Permissions. Removing asks first. The grant becomes revoked, with who removed it and when, and the next matching call asks again. Grants are never deleted, so History keeps the record.
- **A change that takes authority away revokes the grants that relied on it**, recorded with the reason:
  - a folder leaves the hob's folders, because the user removes the hob's own folder, hides a shared folder for the hob, or removes a shared folder in setup (for every hob): the file and command grants in it;
  - the hob's override or the preset narrows an operation to Ask or Never: the hob's grants for that operation;
  - a Charm is ungranted or disconnected: its action grants;
  - the hob is retired: all its grants. Giving the authority back later does not bring a revoked grant back. This keeps a widening a separate, visible user decision.
- **Other policy changes keep grants.** A widening change, such as an override from Ask to Allow, leaves grants in place. A grant only answers the preset's Ask and never overrides a Deny, so it can never widen what the current policy allows.
- **A grant does not pin a policy version.** The policy engine evaluates grants on every call, so a revocation applies to the next call (PE-008). The approval request still pins its policy version, as in ADR 014.
- **Running turns.** File, command and Charm calls are decided call by call. Revoking one of their grants applies at the next call, and the turn keeps running. A host grant may already have opened the sandbox proxy for the turn, so revoking it stops the hob's running turns, like any narrowing in ADR 014.
- **A Quest grant ends with its Quest**, when the Quest completes or is cancelled.

### Storing grants and deciding

- A decision names the request's action digest and is either `{ decision: "approve", lifetime: "once" | "quest" | "always", rules?, confirmed? }` or `{ decision: "deny", reason? }`. `rules` holds one rule per folder, subcommand or host that asked; absent, the request's own rules are saved. Approve once is the existing decision. The hub refuses `quest` or `always` on a request that is not grantable.
- Storing the decision, creating the grant and waking the turn happen in one transaction. Deciding again the same way returns the same request and the same grant, so a doubled click saves one grant and runs the action once.
- A grant records: the hob, the operation, the site and the rule as shown, the lifetime, the Quest if any, the request it came from, who granted it, when, its expiry, when it was last used, and its revocation (who, when, why). `GrantCreated` and `GrantRevoked` are journaled, so open screens update live.
- Only a user session can decide requests or create and revoke grants (PE-006). Hobs, Charms and runtime tools have no route to them. Deciding and revoking require a user session, which only the middleware on the approval and grant routes provides; the [permissions contract](../architecture/permissions.md#agent-control-plane-exclusions) says what counts as one until device tokens exist.

### Where grants show

- **The approval card and the Inbox approval detail** offer Allow once, This Quest (once Quests exist), Always and Deny with a reason, and both decide the same way.
- **Inbox History** lists decisions and the standing rules they created, with what each allows, for which hob, when, and from which request.
- **Settings › Permissions** lists every live rule across hobs, like Claude Code's `/permissions`, with remove.
- **The hob's Permissions tab** shows the hob's own rules beside its answers per operation.

## Rationale

Grants follow Claude Code's and Codex's lesson: a saved approval is a rule the user can read, list and remove, and deny always beats it. Exact command rules are narrower than both tools' prefix rules, on purpose. Approving `pnpm test` must not approve any other command in that folder, which rules out a trailing wildcard. Broader rules can come later through a Settings editor without changing the matcher. A grant answers only the preset's Ask, after every Never, high-risk and narrower Ask, so it can never widen past the current policy or past a narrowing the user made. Revoking grants when the authority they relied on goes away keeps "giving it back" from silently restoring old approvals. A 24-hour limit on pending requests keeps the Inbox honest about what can still be decided. Letting each request say which answers it offers, as the Agent Inbox does, keeps high-risk and unreadable actions to once only.

## Consequences for Slice 8

- **#212 Durable grants:** the grant table and decision shape above, on a new migration for SQLite and PostgreSQL; `grantable` on requests beside `onceOnly`; the policy engine's precedence above, with the layered answer reporting whether an override or restriction asks; command requests carry the command's words, not only its folder, and the hub's command reader decides whether a command can be granted; host, folder, command and Push matching; automatic revocation on folder removal or hiding, narrowing to Ask or Never, Charm removal and retirement; the 24-hour expiry on pending requests; `GrantCreated` and `GrantRevoked` in the journal; grants never answer high-risk actions, safety Asks or narrower Asks.
- **#213 Lifetimes on the card:** Allow once, This Quest hidden until Quests exist, Always with the rule shown and narrowable as the site table allows, Deny with a reason; once only and the check box for high risk; no Always for unreadable commands; the expiry shown.
- **#214 Inbox page:** grouped by hob and thread until Quests exist; detail shows the expiry; deciding there works as on the card.
- **#215 Standing rules:** History and Settings › Permissions list live and revoked rules with their source request; removing asks first and the next call asks again; the hob's Permissions tab shows its rules.
- **#216 Agents cannot grant:** decision and grant routes accept only a user session.
- **#217 End to end:** the scenarios below.

## Validation

The scenarios that would show this decision holds. Each names the issue that will prove it.

- Approving Always for `pnpm test` makes the next `pnpm test` in that folder run without asking, while `pnpm test --watch`, another command, the same command in another folder and the same command for another hob still ask: `[TC-PE-088]`. Through a turn, approving Always for a delete runs the next matching delete without a request while another delete, or the same one for another hob, still asks: `[TC-PE-092]`.
- A command with a glob, variable, `~` or substitution in any word offers no Always and never matches a grant, while the same characters inside single quotes are literal and match only themselves: `rm '*.tmp'` and `rm *.tmp` never share a rule: `[TC-PE-089]`, `[TC-PE-093]`.
- Reading `.git/config` follows the normal policy, while changing it is refused whatever grants exist: `[TC-PE-090]`.
- A grant never answers a call the policy denies, a high-risk push (Trusting included), a safety Ask, or an Ask from the hob's override or a thread, Quest or task restriction: `[TC-PE-090]`. Host, push and delete rules match only their own site: `[TC-PE-091]`. A push that also updates another branch, a pattern refspec, a push from another folder and a line that changes folder, directly, through a wrapper or inside shell control syntax, never reuse a grant: `[TC-PE-097]`. A decision saves no grant once the authority it relies on was narrowed, and revocations for a change wait for a decision saving grants: `[TC-PE-098]`. A delete rule names the path the shell deletes, so a quoted `~` stays literal and its rule never answers the home folder's path: `[TC-PE-099]`. Once a removal is saved, stopping the hob's running turns for a host grant completes even when the request is cancelled: `[TC-PE-100]`.
- A decision whose rule is broader than the card's default, or that asks for Always on a high-risk or unreadable action, is refused by the hub: `[TC-PE-093]`.
- Removing a rule makes the next matching call ask again, and removing or hiding a folder, narrowing an operation to Ask or Never, or retiring the hob revokes its grants, at the hub: `[TC-PE-092]`, `[TC-PE-094]`, `[TC-PE-095]`. Over the HTTP API, on SQLite and PostgreSQL: `[TC-PE-126]`. From Inbox History and Settings › Permissions in the browser: `[TC-PE-125]`.
- Always saves exactly the rule the card showed, as shown or narrowed to the files of the call, and the next matching call runs without asking while another file still asks: `[TC-PE-101]`, `[TC-PE-102]`. A high-risk action offers no Always and needs the check box: `[TC-PE-078]`.
- A request past its expiry shows as expired in the Inbox, offers no approval there, and the hub refuses a late one: `[TC-IN-004]`. After the full 24-hour wait, with the hub's clock moved forward, the turn goes on without running the action and a late approval or Always is refused, on SQLite and PostgreSQL: `[TC-PE-128]`.
- A hob or Charm cannot decide a request, create a grant or revoke one. A request that is not from a user session, such as a script's or another web page's, is refused, recorded in the hub's log, and changes nothing: `[TC-PE-110]`; so is one that would widen a hob's folders, signing or the setup's preset instead: `[TC-PE-113]`. Every route of those groups carries the user-session middleware, and only it provides the user session that deciding and revoking require: `[TC-PE-112]`. A hob's tool calls aimed at the hub's controls stay refused (unknown tools, and loopback, which is never reachable) and are recorded as denied steps while the request stays pending: `[TC-PE-111]`. The OS sandbox keeps a hob's commands, such as `curl` with a forged `Origin`, off the hub's address: `[TC-PE-114]` on macOS, and with real Claude Code in the [evidence record](../evidence/2026-11-01-agents-cannot-grant.md).
- An Always rule appears in History, removing it makes the next action ask again, and double-clicking Approve runs the action once and saves one grant, on SQLite and PostgreSQL. At the hub, one grant per doubled decision, saved in the decision's transaction: `[TC-PE-093]`, `[TC-PE-096]`. Over the HTTP API: `[TC-PE-126]`, `[TC-PE-127]`. In the browser: `[TC-PE-125]`, `[TC-PE-129]`.
- Deciding a request from the Inbox gives the same result as deciding it from the chat: the same request in both lists, the same stored decision and the same reply, at the hub on SQLite and PostgreSQL and for Always and Deny with a reason in the browser: `[TC-IN-017]`, `[TC-IN-018]`. The Inbox and the chat follow each other's decisions: `[TC-IN-003]`.
