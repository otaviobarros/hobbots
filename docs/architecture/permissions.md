# Permissions and autonomy

**Decided:** autonomy-first Trusted Workspace default, enforced boundaries, exceptional approvals, narrowing delegation, separate computer permission and human approval authority. The preset mapping, folders, sandbox and Charms are decided in [ADR 014](../decisions/014-tool-policy-and-enforcement.md). Approval lifetimes and standing grants are decided in [ADR 015](../decisions/015-approval-lifetimes-and-grants.md).

Autonomy is how often an agent proceeds without interruption. Authority is which resources/actions it may use. High autonomy inside a narrow workspace is the default objective. Repeated confirmation for routine authorized edits/tests would violate the product direction.

## Policy presets

Trusted Workspace is the default. The [design](../decisions/008-design.md) names the onboarding presets **Careful**, **Balanced** (Trusted Workspace, the default) and **Trusting**. [ADR 014](../decisions/014-tool-policy-and-enforcement.md) maps them onto the MVP operations; it owns the table and the onboarding wording.

| Operation | Careful | Balanced (Trusted Workspace) | Trusting |
|---|---|---|---|
| Read files | Allow | Allow | Allow |
| Create and edit files | Ask | Allow | Allow |
| Delete files (checked) | Ask | Ask | Allow |
| Run commands | Ask | Allow | Allow |
| Local Git | Ask | Allow | Allow |
| Push (a Charm) | Ask | Ask | Allow |
| Push with force, or to the default branch | Ask, once only | Ask, once only | Ask, once only |
| Use the web | Ask, per host | Allow | Allow |
| Anything outside the hob's folders | Deny | Deny | Deny |

Careful keeps investigation automatic and asks before modifications and consequential work. Trusting is deliberately broad inside the hob's folders and the sandbox, with clear disclosure of actual runtime privileges; it never grants self-approval or Hobbots administration. Per-hob overrides only narrow the table; a widening needs a separately recorded user grant. The UI says **Never** for Deny.

A rule is **enforced** when a runtime or OS boundary holds it whatever the hob does, and **checked** when Hobbots recognizes and decides the operation but a permitted command could perform it another way. Delete files is checked, and so is a push to a remote that accepts pushes without credentials when commands and the web are both allowed; pushes needing credentials are enforced. Local Git is checked where its answer is narrower than Run commands, since any permitted command can run Git another way. The Permissions tab says so. Commands are recognized through assignments and wrappers such as `env` and `timeout`, and in the folder a `cd` earlier in the line moved to; [ADR 014](../decisions/014-tool-policy-and-enforcement.md) has the details.

## Folders

The folders approved in setup are shared by every hob, and each hob can have its own folders on top, added only by the user. Paths are compared canonically: absolute, with `..` and symlinks resolved, a not-yet-existing path through its nearest existing parent, following the volume's case sensitivity. A symlink inside a folder that points outside it is outside. `.git/hooks` and `.git/config` inside a folder are read-only for hobs, and the Hobbots data folder is never reachable from the sandbox.

A hob's own folders, the shared folders it hides and its per-operation overrides are part of its configuration, so changing them creates the next configuration version and a running turn keeps the version it started with. A change that narrows its tools, here or in setup, stops the running turn instead, so no turn keeps authority the user took away. Folders are stored canonical, and so is a hidden folder, whatever spelling of the shared folder the user picked; a folder missing from the hub, such as one on an unmounted drive, keeps its spelling until it returns. A shared folder is hidden when a hidden entry names the same folder now, compared canonically each time the hob's folders are worked out, so canonicalizing a shared folder later, at hub start or when setup is saved, never shows a hidden one again. An override is rejected when it would allow more than the installation's preset; the effective answer is always the narrower of the preset and the override, so an override saved under one preset cannot widen a stricter preset picked later.

## Effective policy

Evaluate the applicable user, executor/environment, receiving agent, thread/Quest/task and specific-action constraints as an intersection. Delegation adds task restrictions; it never unions unrelated privileges. Permission to invoke an agent is distinct from permission to access that agent's resources. Thread overrides normally narrow scope; an expansion requires a separately recorded user grant.

Resource categories include filesystem, terminal, network, Git, GitHub/external apps, browser, computer, delegation and Hobbots APIs; the MVP operations and their normalization are in [ADR 014](../decisions/014-tool-policy-and-enforcement.md). Keep concurrency/cost/time budgets distinct from security permissions. Evaluate Allow / Ask / Deny for a normalized operation and concrete resource, not for the model's description of intent.

## Trusted engineering example

Automatically allow authorized repository reads/searches/edits, tests/builds, local branches/commits and permitted delegation. Dependency installation is automatic only when covered by environment policy. Protected pushes/merges require additional approval under the reference policy. Personal/out-of-scope files are denied. Host desktop control requires separate explicit permission. Integrations can have standing scoped authorization, so “external” does not universally mean “ask every time”.

## Approval contract

Show the requesting agent, operation, target system/resource, concrete arguments/constraints, expected changes and impact. Bind a decision to identity, executor, action digest, resource scope, policy version, expiration and revocation. Retain durable request/decision/execution evidence.

The approval lifetimes are **just this once**, **for this Quest** and **always for this site** (a standing permission bounded in scope, removable from Inbox history). High-risk actions offer once only and need a confirmation check box. Deny takes an optional reason that goes back to the hob. Expired or stale requests cannot be approved late; the hob asks again with fresh facts. These replace the six proposed choices (Allow once/for task/for thread, Always allow, Deny, Always deny). Matching and expiry for Approve once and Deny are decided in [ADR 014](../decisions/014-tool-policy-and-enforcement.md#asking-the-user). An approval for a test command is not approval for arbitrary shell commands or a changed target. Revalidate immediately before execution, and deduplicate decision/application operations.

[ADR 015](../decisions/015-approval-lifetimes-and-grants.md) decides the Quest and site lifetimes:

- **A grant** is saved by This Quest or Always. It belongs to one hob and names one operation and one site: a folder for file operations (the files directly in it), an exact command in a folder for Run commands and Local Git, an exact host for Use the web, an action and its target for a Charm (Push to a remote and branch). Delegation never passes a grant on.
- **The rule is shown before it is saved** and can be narrowed. It is never broader than the request: approving `pnpm test` in a folder matches only `pnpm test` in that folder. Only literal commands can be granted: a command with a glob, variable, `~` or substitution in any word, or with `sh -c`, `cd` or a redirection, offers once only.
- **Precedence:** always-denied targets first (changes to the protected Git paths, not reads), then Never from any layer, then high risk (which asks even where the layers allow), then safety Asks, then Allow. A grant answers only the preset's Ask. An Ask from the hob's override or a thread, Quest or task restriction still asks.
- **High risk** (a force push, a push to the default branch, a Charm action its Charm marks high risk) is once only with the check box and never granted.
- **A pending request** stays open for at most 24 hours, and expires sooner when its turn ends.
- **Revocation:** removing a rule asks first and makes the next matching call ask. Removing or hiding a folder, narrowing an operation to Ask or Never, ungranting a Charm or retiring the hob revokes the grants that relied on it; giving the authority back does not restore them. Grants are checked on every call; revoking a host grant also stops the hob's running turns.
- **This Quest** is stored now and offered once Quests exist; until then the Inbox groups requests by hob and thread. Standing rules are listed in Inbox History and Settings › Permissions.

Agents may request authority but cannot manufacture human approval, access user credentials, or call administrative grant routes. Agent MCP credentials are distinct from user sessions and limited to authorized orchestration operations. Approval denial is enforced even if the runtime continues requesting the action.

## Enforcement honesty

Hobbots-managed tools pass through the permission broker. Native runtime tools use verified provider approval/sandbox hooks or an isolated environment. Arbitrary unsandboxed shell execution can escape a nominal workspace; a system prompt is not a filesystem boundary. Each adapter declares what it can enforce, observe or cannot guarantee. Block operations requiring unavailable enforcement rather than showing a reassuring but false Trusted badge.

[ADR 014](../decisions/014-tool-policy-and-enforcement.md) sets the mechanism. Two layers are both required before a hob gets tools:

- **The runtime's permission hooks** decide every tool call through the policy engine (for Claude Code, a `PreToolUse` hook that sees every call before the SDK approves any on its own, with `canUseTool` only waiting for approvals and nothing loaded from settings on disk).
- **One OS sandbox around the whole runtime process**, Anthropic's sandbox-runtime (Seatbelt on macOS, bubblewrap on Linux), generated per turn from the effective policy. It denies reads of the user's data outside the hob's folders, allows writes only in the hob's folders and a private temporary folder, and sends all network traffic through a proxy that asks the policy engine about each new host. Child processes inherit it. The runtime's own sandbox stays off inside it.

A sandbox that cannot start fails the turn; it never falls back silently. Where the sandbox is unavailable (Windows until sandbox-runtime's backend there matures, or a hub missing its prerequisites), commands, local Git and the web are blocked and labeled "Needs the sandbox"; file tools still work through the permission hooks.

The sandbox is on by default for every hob. The user can turn it off for one hob, as a recorded grant with a confirmation check box, or let new hobs start without it when picking Trusting. An unsandboxed hob is labeled **Unsandboxed** wherever it appears, and its folder and network rules become checked rather than enforced.

## Charms

A **Charm** is a connection that gives a hob abilities beyond its runtime's own tools: an integration with another app or service such as GitHub, Slack, Google Drive or any MCP server. The user connects a Charm on the hub once and grants it per hob; each of its actions is Allow, Ask or Never per hob. The MVP ships the built-in GitHub Charm with Push. A Charm runs in the hub process outside the runtime sandbox, is offered to the runtime over its control channel rather than the network, and goes through the policy engine with Allow / Ask / Never on its exact arguments. Credentials a Charm needs stay on the hub and never enter the sandbox, so the Charm is the only route to effects that need them; a push to a remote that accepts pushes without credentials is a checked rule. A Charm never runs workspace code: Push runs no repository hooks or configured programs. The sandbox never blocks a Charm the user granted. Hobbots' coordination tools (delegation, messages between hobs, results) are not Charms and keep the control-plane exclusions below.

Credentials remain scoped to the hub's execution environment or secrets provider and are excluded from messages/events. Hobs act only on the hub; a connected device never exposes its own files or apps. Device tokens, execution grants and agent tool credentials are separate boundaries ([deployment](deployment.md)).

Verify denial, grant scoping/expiry, policy changes during waits, child privilege escalation attempts, duplicate decisions, changed arguments after approval, unsupported enforcement and separate computer opt-in. Full Access does not remove application-level authentication or create administrative agent APIs.


## Secrets in tool activity

Tool calls and their results reach the hub, the event journal, the database and every client, and builds and scripts often print tokens. Hobbots redacts secrets from what it stores and shows before a tool step or approval request is saved, journaled or sent, so a client that resumes later never receives the raw value. A redacted value becomes a marker that says what it was, such as `[redacted: GH_TOKEN]` or `[redacted: private key]`, never the value.

- **Known values.** The hub redacts each credential it knows by value: every variable in its environment whose name says it holds one (a token, secret, password or credential, or a name with a `KEY` or `AUTH` part such as `ANTHROPIC_API_KEY`), provider keys among them, and the sign-in an adapter puts in a turn's environment. Charm credentials join them when Charms store any. A known value shorter than 8 characters or a plain number is not redacted, and neither is a variable that names where a credential lives, such as `SSH_AUTH_SOCK` or one ending in `_FILE` or `_PATH`.
- **Secret shapes.** Values Hobbots does not know are recognized by shape: private key blocks (one cut short is redacted to its end), bearer tokens, passwords in URLs, credential assignments such as `API_TOKEN=…` (a quoted value to its closing quote), and well-known provider key prefixes (Anthropic, OpenAI, GitHub, GitLab, Slack, AWS, Google, Stripe, npm and JSON web tokens).
- **What it covers.** A tool step's label, targets and reason, an approval request's arguments, label, targets and reason, the error a runtime reports when a turn fails, and tool output and full logs once Hobbots keeps them. A label is redacted before it is shortened, so a cut never leaves part of a secret behind. An approval's action digest is still taken over the call exactly as it would run, so an approval matches only that call.
- **What it leaves alone.** The runtime's own session, which the model sees inside its sandbox. The user's own messages. The reply's text, which is the model's writing: a model that quotes a secret it read is not redacted yet.
- **Limits.** Redaction is best effort and never a boundary. A secret Hobbots does not know and that has no recognized shape, one split or encoded by a command (such as base64), or one spread across streamed pieces passes through. An approval's action digest is an unsalted hash over the raw call, so someone holding the journal could test guesses at a weak secret in it. Keeping credentials out of the sandbox (above) remains the protection; redaction only keeps what does leak out of Hobbots' records and screens.

## Agent control-plane exclusions

The agent-facing MCP control interface excludes **approval grants, credentials, deletion, and computer lifecycle operations**. Keep this boundary for agent-facing Hobbots controls: no administrative record deletion, credential administration, or creating/destroying computer environments through agent MCP credentials. Human-authorized management uses a separate user control path.

Only a user session decides approval requests, saves grants and removes them, and only a user session changes what hobs may do (a hob's folders, overrides and signing, and the setup's preset and folders), so a refused decision cannot be sidestepped by widening the policy instead (PE-006, [ADR 015](../decisions/015-approval-lifetimes-and-grants.md)). Every route in the approval, grant, permissions and setup groups sits behind the hub's user-session middleware, which provides the user session the services require to decide or revoke; only that middleware provides one, so a hob tool, a Charm or an agent-facing control added later cannot call them without it, and a test fails when any other code names it. Until device tokens exist ([deployment](deployment.md)), a user session is a browser client of the hub: a request whose `Origin` is the hub's own, or a read marked same-origin by `Sec-Fetch-Site`. A checkout, or a hub started with `HOBBOTS_ALLOWED_ORIGINS` set (as the desktop app's development build does), also trusts those client origins, such as the Vite dev server's; a packaged hub trusts only its own origin. A request without either (a script, a command, a runtime's HTTP client) or from another web page gets `403 UserSessionRequired`, and the hub's log records the attempt. This check is not authentication: a sandboxed hob never reaches the hub's address, so it holds whatever the hob sends, while an unsandboxed hob's command could imitate a browser, so for it the rule is checked, not enforced, like its other rules. The event stream is not behind it, so it is no confidentiality boundary for approvals. A hob's own tool calls aimed at Hobbots' controls are unknown tools, or a loopback address the policy never allows, and are refused, recorded as denied steps in its reply.

This is a control-plane restriction, not a blanket prohibition on ordinary authorized workspace edits/removals. Workspace operations still follow the concrete resource/tool policy. The optional computer viewing/control capability and its separate permission do not grant agents authority to administer host computers or their lifecycle.

## Snapshots and changing authority

Keep the original configuration/policy snapshot for provenance. A historical snapshot is not a permanent authorization grant: re-evaluate applicable current restrictions, revocations, grant expiry and action-specific approval immediately before the next effect or continuation. A newly narrowed policy cannot be bypassed by continuing an older attempt or replaying an earlier approval. Exact interruption of an already-running native tool is adapter-dependent and must be recorded honestly; new disallowed effects must be prevented.
