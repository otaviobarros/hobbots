# Threat model

This page says what Hobbots protects, from whom, and which boundaries hold it. Security reviews, human and automated, read it to decide whether a finding is real and how severe it is. The rules themselves live in the [permissions contract](architecture/permissions.md), the [deployment contract](architecture/deployment.md) and the [security standards](standards/security.md). [SECURITY.md](../SECURITY.md) says what is in scope for a report. When this page and a contract differ, the contract wins and this page is out of date.

## The system in one paragraph

One computer, the hub, runs the Hobbots server as a background service with one database and a data folder ([ADR 010](decisions/010-desktop-hub.md)). Hobs are AI agents that run Claude Code or Codex on the hub, signed in with the user's own accounts. Each hob works in folders the user approved, inside an OS sandbox, and calls the hub's own tools over a control channel. Clients (the hub's window, a connected desktop, a browser) reach the server on loopback or, when remote access is on, over Tailscale. Every client but the hub's window is an approved device.

## What we protect

- **The user's files** outside the hob's folders, and the integrity of files inside them.
- **Credentials:** runtime sign-ins, Charm tokens such as the user's GitHub account and a hob's GitHub App key, device tokens and the window key. They live in the OS keychain or the data folder and never enter the sandbox.
- **The hub's records:** threads, messages, memory, Tasks, Quests, approvals and grants, in the database and data folder.
- **Authority:** who may approve, grant, widen a hob's policy or administer the hub. Only a user session from an approved device holds it.
- **The user's accounts on other services**, reached through Charms: what gets pushed, commented or opened in their name.
- **The hub's availability** for every hob and person on it.

## Who can attack

| Actor | What they control | What they want |
|---|---|---|
| A page a hob reads, or a search result | Text the model reads (prompt injection) | Make a hob send data out, push, comment or save something on the attacker's behalf |
| A repository or file in a hob's folder | Code, Git config and hooks, build scripts, text the model reads | Run code outside the sandbox, steal credentials, reach the hub |
| A hob itself, misled or misbehaving | Its tool calls and commands, within its authority | Cross its folders, reach a host it may not, approve its own request, widen its authority or another hob's |
| Another hob | Its messages, briefs, delegated Tasks and public card | Get a hob with more authority to act for it |
| An MCP server connected as a Charm | Its tool answers | Inject instructions, or get a write approved on misleading arguments |
| A device on the tailnet that is not approved | Network requests to the hub's address | Read records or act as the user |
| Another web page in the user's browser | Cross-site requests to `localhost` or the tailnet address | Use the device cookie to act as the user (CSRF), or read answers |
| A crafted string in any input | Length and shape of text | Stall the hub with backtracking patterns (STD-SEC-005) or oversized payloads |

Not in this model: an attacker who already controls the hub's user account or OS, the runtimes' own vendors and models, and the Tailscale control plane. [SECURITY.md](../SECURITY.md) lists what is out of scope for a report.

## Trust boundaries

Each boundary is **enforced** when the OS or a runtime holds it whatever the hob does, or **checked** when Hobbots recognizes the operation but a permitted command could do it another way. A finding that crosses an enforced boundary is serious. Getting around a checked rule is a known limit, unless the contract claims more than it delivers.

| Boundary | Holds it | Kind |
|---|---|---|
| Hob to files outside its folders | OS sandbox (Seatbelt, bubblewrap) around the whole runtime process, generated per turn | Enforced; checked for an unsandboxed hob |
| Hob to the network | Sandbox proxy that asks the policy engine about each new host; `web_fetch` resolves, checks and pins each address and refuses loopback, link-local, metadata and tailnet addresses | Enforced; checked for an unsandboxed hob |
| Hob tool call to effect | Runtime permission hooks decide every call through the policy engine before it runs | Enforced |
| Hob to credentials | Credentials stay in the hub process and keychain; Charms run outside the sandbox and push from a staging repository the hub owns, running no repository hooks | Enforced |
| Hob to `.git/hooks`, `.git/config` and the data folder | Read-only or unreachable from the sandbox | Enforced |
| Delete files, local Git narrower than commands, credential-free pushes | Command recognition in the policy engine | Checked |
| Hob to approvals, grants and policy | Only a user session decides or widens; the device middleware alone provides it; agent MCP tools exclude administrative powers (STD-SEC-004) | Enforced for a sandboxed hob, which cannot read the window key or reach the hub's address |
| Delegation and Summoning | A receiver gets at most the sender's authority; a wider change becomes a proposal only a user session applies (STD-SEC-003) | Enforced in the hub |
| Text from outside to instructions | Outside data is labeled as data in tool answers, cards and briefs | Guidance to the model only; never counted as a boundary (STD-SEC-002) |
| After reading the web | The read-the-web mark makes URLs the hob wrote, new hosts, pushes, Charm writes and shared memory saves ask until the session ends | Enforced in the hub; the proxy refuses instead of asking |
| Client to server | Approved device token (bearer or `HttpOnly` cookie, stored hashed), `Origin` checks for cookie requests, no CORS headers, loopback only unless remote access is on | Enforced |
| Tailnet to server | Only loopback and peers `tailscale whois` knows; never Funnel; tailnet membership is not authentication | Enforced |
| Electron renderer to native | Context isolation and a narrow, validated preload bridge | Enforced |
| Secrets in records | Redaction of known values and secret shapes before storing or sending | Best effort; never a boundary |

## What a reviewer should look for

These are the changes most likely to break a boundary above. Treat them as high severity when they are reachable.

- A tool, route or Charm action that runs without going through the policy engine, or that decides on the model's description instead of the normalized operation and its concrete resource.
- A path compared without canonicalizing it (absolute, `..` and symlinks resolved, case sensitivity of the volume), or a symlink inside a folder followed outside it.
- A sandbox profile that grows reads, writes or network outside the effective policy, or a turn that runs when the sandbox failed to start.
- A credential, token or key passed into the sandbox, an environment variable, a command line, a log or an event.
- An HTTP route or event stream outside the device middleware, a cookie request accepted without its `Origin`, or a CORS header.
- Code other than the device middleware that provides a user session, or a hob-reachable path that approves, grants, widens a policy, deletes records administratively or manages devices.
- Delegation, a brief, a message or a Summoning change that passes on more authority, a grant or a found URL the sender did not have.
- An address fetched without resolving and pinning it, a redirect not decided again, or a private, loopback or metadata address reachable.
- A Charm or push that runs repository code, hooks or configured programs, or sends a write twice.
- Outside text (a page, a file, a hob's card or message, an MCP answer) used as an instruction, a command, a path or a URL without being labeled and decided.
- A regular expression over outside text that can backtrack (STD-SEC-005), or input read without a size limit.
- A person's record written under a fixed owner instead of the user session's actor (STD-SEC-006).
- A runtime adapter change that holds one of these rules for Claude Code but not Codex, or the reverse.

## Known limits

- An unsandboxed hob, which the user turns on with a recorded grant, has only checked folder and network rules, and could read the window key.
- A host the user saved Always for stays reachable after a session reads the web, so a command can still send data there.
- Redaction misses secrets it does not know that have no recognized shape, or that a command split or encoded.
- Codex's own search can open pages Hobbots cannot see, so it is offered only where Use the web is Allow and no site is blocked. That change is not yet checked with real models ([PRIVACY.md](../PRIVACY.md)).
- Where the sandbox is unavailable, commands, local Git and the web are blocked rather than run unprotected.
- The hub is single user today. [ADR 039](decisions/039-shared-camps.md), still proposed, adds other people; once it is accepted this page gains a person-to-person boundary.
