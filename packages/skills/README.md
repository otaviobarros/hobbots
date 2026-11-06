# packages/skills

Skills for hobs, as [ADR 029](../../docs/decisions/029-skills.md) decides it. This package holds the files of every revision, import from a folder, an archive or Git with its checks, and `~/.agents/skills` read by the hub. The library's records are `SkillLibrary` (from `@hobbots/agents`), kept by `@hobbots/persistence`. No other package imports this one, and it imports no runtime and no Charm (`pnpm lint:layers`).

## The object store

- `SkillObjectsLive(dataFolder)` keeps each revision's files in `<data folder>/skills/objects/<hash>/`, read-only, and provides `SkillFiles` so the hub can hand a revision's folder to a turn. A revision is written into a staging folder and moved into place whole; content that is already there is not written again.
- A revision's hash is the SHA-256 of one line per file, sorted by the path's UTF-8 bytes: `<mode> <SHA-256 of contents> <path>`, with Git's `100644` or `100755` as the mode (`revisionHash`). The same files always give the same hash.

## Import

`SkillImporter` reads a source as a tree of entries, finds every folder with a `SKILL.md` up to five levels down that is not inside another one, checks each, and adds the ones you pick to the library as new skills or as new revisions of one. `scan` does the same and writes nothing, so a repository with many skills lists them to pick from. Content the library already has answers the revision it is.

- **Sources.** A folder is listed without following any link, leaving out `.git` and `node_modules`. An archive (`.zip`, `.skill`) is read from memory with [yauzl](https://github.com/thejoshwolfe/yauzl) and never unpacked to disk; names are read as the archive gives them, so one that reaches outside the skill is refused. A Git repository is fetched with the `git` command at one commit (`--depth=1`) into an empty bare repository with an empty hooks folder, over HTTPS, SSH or a local path only, and read from Git's objects with nothing checked out; the commit is kept on each revision. The `git` command is used rather than a library so your SSH keys and credential helpers work as they do for you. A skill written in Hobbots is a source like any other.
- **Checks**, before anything is written: front matter between `---` lines that is YAML, with a `name` of lower-case letters, digits and single hyphens and a `description` of at most 1,024 characters; no link, no special file, and no path or Markdown link (outside code blocks) that reaches outside the skill; at most 200 files and 5 MB. A refusal names the file and the rule. No script ever runs.
- **What is dropped**, with a note on the revision: a Claude Code plugin's `hooks`, `commands`, `agents` and `.mcp.json` (only its `skills` are read), `allowed-tools` in the front matter, and `dependencies` in Codex's `agents/openai.yaml`. The MCP tools those dependencies name join `metadata.hobbots.charms` as Charm hints.
- **Flags** for a careful look: a script (an executable file, a script's extension or a `#!` line), each URL in a text file, and the first hidden character in it (zero-width, direction overrides, tag characters).
- **`skills-lock.json`.** When the source has the `skills` CLI's lock file at its top, a skill it names is followed at the Git source the lock gives, and a scan says whether the copy matches the lock's `computedHash` (`skillsCliHash` repeats the CLI's own hash).
- **Labels.** A plugin's `version`, or `metadata.version` in the front matter, is kept as a label only.

## `~/.agents/skills`

`AgentsFolderLive(path)` reads the shared folder at start, when it changes and every five minutes. Each `<name>/SKILL.md` there that passes the checks is a library skill from that folder, assigned to Everyone; a change makes a new revision, rolled out to every assignment that is not held. A skill taken out of the folder leaves Everyone and stays in the library. One that fails a check, or whose name the library has from elsewhere, is listed in `problems` and not taken. The server reads `~/.agents/skills` with a real runtime, nothing with the fake one, and `HOBBOTS_AGENTS_SKILLS` names another folder or `off`.

## Tests

- `test/import.test.ts` imports from folders, archives, a local Git repository and text written in Hobbots: one revision per content, every refusal with nothing written, a plugin with only its skills, Codex's dependencies, flags, a pick from a repository's skills, and `skills-lock.json`.
- `test/agents-folder.test.ts` reads a stand-in `~/.agents/skills`, a change rolled out, and a skill taken out.
- `@hobbots/skills/testing` exports `SkillLibraryFake`, the library in memory.
