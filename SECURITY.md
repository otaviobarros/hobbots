# Security policy

Hobbots runs AI agents on your machine with access to the folders, commands and network you allow. A flaw that lets a hob act outside those boundaries is a security issue, and so is anything that exposes your threads, tokens or files. Thank you for reporting one privately.

## Report a vulnerability

Report it through GitHub's private vulnerability reporting: open the repository's [Security tab](https://github.com/otaviobarros/hobbots/security) and choose **Report a vulnerability**. The report stays private to you, the maintainer and any collaborators they invite to the advisory.

Do not report a vulnerability in a public issue, pull request or discussion.

A useful report includes:

- What an attacker can do, and what they need first (a malicious repository, a crafted web page, access as another local user, a hob's prompt, and so on).
- Steps to reproduce, with the Hobbots version or commit, operating system and version, and the runtime and its version.
- Any proof of concept, logs or screenshots. Remove your own secrets and personal data first.

## What to expect

Hobbots is maintained by one person, so there is no guaranteed response time. You can expect:

- An acknowledgement, usually within a week.
- An assessment of whether the issue is in scope and how severe it is.
- Updates in the private advisory while a fix is prepared, and credit in the published advisory unless you prefer to stay anonymous.

Please give the fix a reasonable chance to ship before you disclose the issue publicly. The disclosure date is agreed in the advisory.

## Supported versions

Hobbots is an early build. Fixes land on `main` and ship in the next release; older releases do not get backports. Check that the issue still happens on the [latest release](https://github.com/otaviobarros/hobbots/releases/latest) or on `main` before reporting it.

## Scope

In scope:

- The code in this repository: the server, web client, Mac app and packages.
- The Mac app installers published on this repository's releases.
- The hobbots.app website, whose code lives in `apps/site`.
- Ways for a sandboxed hob to cross a boundary that [the permissions contract](docs/architecture/permissions.md) marks as enforced, such as reading outside its folders, running commands it was not allowed to run or reaching hosts it was not allowed to reach.

Out of scope:

- Vulnerabilities in the agent runtimes Hobbots hosts, such as Claude Code or Codex. Report them to their vendors. If Hobbots makes such a vulnerability worse or easier to reach, that part is in scope.
- What a hob does within the permissions you gave it, including following instructions it reads in files or web pages, unless it crosses a boundary Hobbots claims to enforce.
- Getting around a rule the permissions contract marks as checked rather than enforced, or a boundary of a hob running unsandboxed. The contract documents these limits and the Permissions tab shows them.
- Attacks that need an already compromised Mac or user account.
- Missing hardening without a demonstrated impact, such as absent headers or best-practice reports from scanners.
- The app being unsigned. This is known; see [Install the Mac app](README.md#install-the-mac-app).
