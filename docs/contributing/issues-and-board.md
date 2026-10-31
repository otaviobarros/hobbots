# Issues and the project board

Hobbots plans and tracks work in public [GitHub Issues](https://github.com/otaviobarros/hobbots/issues). Each issue has a type, an area and a priority, so the list can be filtered by any of them. The milestone gives the release, the parent issue gives the slice, and the project board shows each issue's status.

## How work is organized

| Level | Where it lives | Example |
|---|---|---|
| Release | Milestone | `MVP` |
| Vertical slice | Issue labeled `type: slice` | Slice 3: Hub background service |
| Step of a slice | Sub-issue labeled `type: task` | Install the server as a macOS login item |
| Pull request | Links its issue with `Closes #N` | `feat(desktop): add login item service` |

A **vertical slice** is an outcome a user can try end to end, cutting through every layer it needs (server, persistence, web, desktop). Slices are ordered by the plan in the milestone; each one should be shippable on its own. Its steps are [sub-issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues), so the slice shows how many steps are done and the board can group tasks by slice.

## Opening an issue

Open a new issue and pick a form. Blank issues are turned off so every issue starts with the details triage needs.

| Form | Use it for | Labels it adds |
|---|---|---|
| Bug report | Something does not work as documented. | `type: bug`, `status: triage` |
| Feature request | New behavior you would like to see. | `type: feature`, `status: triage` |
| Vertical slice | Maintainers planning a milestone. | `type: slice`, `status: triage` |
| Task | One step of a slice, or a small standalone change. | `type: task`, `status: triage` |
| Role request | A hob role missing from the starter set. See [Role requests](#role-requests). | `type: feature`, `area: design`, `status: triage` |

Search existing issues first, write one problem per issue, and never paste API keys, device tokens or private files. Report security vulnerabilities privately through the repository's Security tab, not in a public issue.

## Labels

Labels use a `group: value` prefix so they sort together and filter cleanly. Every triaged issue has exactly one `type:` label, at least one `area:` label and one `priority:` label. [`.github/labels.json`](../../.github/labels.json) is the source of truth; change labels there and run the sync script rather than editing them on GitHub.

| Group | Labels | Meaning |
|---|---|---|
| Type | `type: slice`, `type: task`, `type: bug`, `type: feature`, `type: docs`, `type: chore` | What kind of work it is. |
| Area | `area: desktop`, `area: server`, `area: web`, `area: runtime`, `area: persistence`, `area: orchestration`, `area: permissions`, `area: devices`, `area: design`, `area: ci`, `area: docs` | Which part of Hobbots it touches. |
| Priority | `priority: p0`, `priority: p1`, `priority: p2` | p0 is needed for the current milestone, p1 should follow soon, p2 is nice to have. |
| Status | `status: triage`, `status: needs info`, `status: blocked` | Exceptions only. Day-to-day progress lives in the board's Status field. |
| Community | `good first issue`, `help wanted` | Work that newcomers or contributors can pick up. |
| Resolution | `question`, `duplicate`, `wontfix`, `invalid` | Why an issue closed without a change. |

To sync labels (needs the [GitHub CLI](https://cli.github.com/) with write access):

```sh
node scripts/sync-labels.mjs            # create, update and rename labels
node scripts/sync-labels.mjs --prune    # also delete labels missing from labels.json
```

## Triage

A maintainer triages new issues at least once a week. For each issue labeled `status: triage`:

1. Close it with `duplicate`, `invalid` or `wontfix` and a short comment if it will not be worked on as filed.
2. Ask for details with `status: needs info` if it cannot be understood yet. Issues waiting for information for 30 days may be closed.
3. Otherwise confirm the `type:` label, add `area:` and `priority:` labels, and set the milestone if it belongs to a release.
4. Attach tasks to their slice as sub-issues. A slice's last task proves it end to end ("Prove …"); write its checks from the Validation scenarios of the slice's ADRs, and close it with an [evidence record](../evidence/README.md) and an update to the [status page](../STATUS.md).
5. Add `good first issue` or `help wanted` where it fits, then remove `status: triage`.

## Role requests

Hobs are getting roles: a title, a sigil and the hat and tool the sprite wears. The starter set of roles, with their families and picker order, is planned in [#99](https://github.com/otaviobarros/hobbots/issues/99) and will live as data in `@hobbots/domain`. Anyone will be able to give a hob a title in their own words, so the starter set only grows when many people need the same role. Roles are labels only and grant no extra powers.

To suggest a role, open the [Role request](https://github.com/otaviobarros/hobbots/issues/new?template=5-role-request.yml) form. Once the role picker lands ([#100](https://github.com/otaviobarros/hobbots/issues/100)), its "Missing a role? Suggest one" link will open the same form with the title filled in from what the user typed, using the `title=Role: <title>` and `role-title=<title>` query parameters.

How requests are accepted:

1. **One issue per role.** A request that names several roles is closed and asked to be split.
2. **Vote with 👍.** React to the request rather than commenting "+1". A duplicate is closed with `duplicate` in favour of the first request for that role.
3. **Reviewed once per release.** Before each milestone closes, maintainers review open role requests, weighing votes, the examples given and how far the closest existing role falls short.
4. **At most four new roles per release.** The rest stay open for the next review, or close with `wontfix` and a reason.
5. **The set is capped at 60 roles.** Past that, a new role has to replace one that is rarely used.
6. **Maintainers draw every sigil.** The sigil idea in a request is a starting point; maintainers draw the final 10 × 10 sigil and pick the hat and tool so the whole set keeps one style.

Requests for brands or logos, or for religious, political or violent imagery, are closed with `invalid`.

## The project board

The [Hobbots project](https://github.com/users/otaviobarros/projects) collects every issue and pull request in the repository.

### Fields

| Field | Values | Notes |
|---|---|---|
| Status | Backlog, Ready, In progress, In review, Done | Ready means scoped and unblocked. Move the card as work progresses. |
| Size | XS, S, M, L, XL | Rough effort: XS under an hour, XL more than a week. Split anything bigger than L. |
| Milestone, Labels, Assignees, Parent issue, Sub-issue progress | Built in | Shown from the issue itself; edit them on the issue. |

Priority and area are labels rather than board fields, so they are visible and filterable outside the board too.

### Views

| View | Layout | Filter and grouping |
|---|---|---|
| Board | Board by Status | `milestone:MVP` |
| Triage | Table | `label:"status: triage"`, sorted by creation date |
| Slices | Table | `label:"type: slice"`, sorted by title, with Sub-issue progress shown |
| By slice | Table | `-label:"type: slice"`, grouped by Parent issue |
| My work | Board by Status | `assignee:@me -status:Done` |

Useful filters: `label:"priority: p0" -status:Done`, `label:"area: desktop"`, `label:"status: blocked"`, `no:assignee status:Ready`.

### Workflows

Turn on these built-in project workflows:

- **Auto-add to project:** repository `otaviobarros/hobbots`, filter `is:issue,pr is:open`.
- **Item added to project:** set Status to Backlog.
- **Item reopened:** set Status to Backlog.
- **Item closed** and **Pull request merged:** set Status to Done.
- **Auto-archive items:** `is:closed updated:<@today-30d`.

### Setting up the board

A maintainer does this once:

1. Create a project from the account's **Projects** tab with the **Board** template and name it `Hobbots`.
2. Link it to the repository from the repository's **Projects** tab.
3. Rename the Status options to the five above and add the Size field.
4. Create the views and turn on the workflows listed above.
5. Set the project's visibility to public once the repository is public.

## Working on an issue

1. Comment on the issue before starting so work is not duplicated, then get it assigned.
2. Move the card to In progress and branch from `main` as `<type>/<issue>-<slug>`, using the Conventional Commit type (`feat/42-login-item`, `chore/23-agent-engineering-plugin`). One issue per branch.
3. Commit with [Conventional Commits](https://www.conventionalcommits.org/) (`feat(desktop): ...`, `fix(server): ...`, `docs: ...`).
4. Open a pull request using the template, with `Closes #N`. The card moves to In review by hand and to Done when the pull request merges.
5. Run `pnpm check` before asking for review.
