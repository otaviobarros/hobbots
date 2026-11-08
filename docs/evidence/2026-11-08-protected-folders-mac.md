# macOS asks about a protected folder when it is added, and hobs on both runtimes then write there

- **Date:** 2026-11-08
- **Issue:** [#1225](https://github.com/otaviobarros/hobbots/issues/1225), [#1219](https://github.com/otaviobarros/hobbots/issues/1219)
- **Pull request:** [#1255](https://github.com/otaviobarros/hobbots/pull/1255)
- **Commit:** `3f2b744` and `5ceab94` on `claude/project-thread-35t8m9`, each built from a clean worktree. `3f2b744` opens a hob's own new folders; `5ceab94` also opens new shared folders in setup and Settings. The commit after them changes only the refusal's wording off macOS and this record, and was not packaged.
- **Setup:** Apple M1 Pro, macOS 27.0.1, arm64. Each commit was an ad hoc signed `pnpm package:mac` build, started by path from its `.dmg` with `HOBBOTS_MODE=hub`, `HOBBOTS_LOG_LEVEL=Debug`, a new data folder (`--user-data-dir`), its own port and opening at login off, never the Mac's Hobbots data. Balanced preset. Codex 0.166.0 with `gpt-6-luna` and Claude Code with `haiku`, both signed in, on low effort; the Claude Code version was not recorded. Folders were added and turns started through the hub's API. macOS's privacy decisions were read from `log stream --predicate 'subsystem == "com.apple.TCC"'`.
- **Result:** Passed with gaps. macOS asked about Documents when the folder was added, both runtimes then wrote there with no prompt during the turn, and a refused folder was not added. Allow on the shared-folder path was not run.

## Before the fix

On an ad hoc signed build of `main` with the Debug line added, a Codex hob's turn listed `~/Documents/Hobbots` with read and write access. During that turn the TCC log showed macOS's Documents request for Hobbots, whose prompt gave no reason and held the turn for about 86 seconds. A Codex 0.166.0 turn in Hobbots' sandbox started from a terminal wrote to the same folder every way it tried, so the sandbox profile and Codex's writable roots were not the cause.

## Checks

| Case | Check | Result |
|---|---|---|
| Manual | The packaged `Info.plist` has `NSDocumentsFolderUsageDescription`, `NSDesktopFolderUsageDescription`, `NSDownloadsFolderUsageDescription`, `NSRemovableVolumesUsageDescription` and `NSNetworkVolumesUsageDescription`, each with the reason text | ✅ on both builds |
| Manual | Adding `~/Documents/Hobbots` as a hob's own folder brings macOS's Documents prompt at once | ✅ `3f2b744`: requested at 14:11:08.324, allowed at 14:11:12.201 (User Consent), from `ai.hobbots.app.helper` with `ai.hobbots.app` responsible |
| Manual | A Codex hob writes `fix-check.html` there | ✅ `3f2b744`: the turn's line read `Sandbox for codex: folders [~/hobbots-qa/1225-fix/work, ~/Documents/Hobbots], read true, write true`; `cat > … <<'EOF'` exited 0, the file had 107 bytes, and the request took 864 ms |
| Manual | A Claude Code hob writes `fix-check-cc.html` there | ✅ `3f2b744`: the Write tool answered "File created successfully", 226 bytes, 182 ms |
| Manual | No TCC request for Hobbots during either turn | ✅ `3f2b744` |
| Manual | Adding a shared folder in setup brings the prompt at once | ❌ `3f2b744`: no TCC request at all, so setup did not open the folder. ✅ `5ceab94`: requested at 14:16:57.773, at the add |
| Manual | A shared folder macOS refuses is not added | ✅ `5ceab94`: Documents refused at 14:17:00.566 and Desktop (`~/Desktop/hobbots-qa-1225`) at 14:17:26.675. Each add answered 400, stored nothing, and said "Hobbots can't open … If macOS asked, allow Hobbots in System Settings › Privacy & Security › Files and Folders, then add the folder again" |
| `[TC-RT-1225-01]` | A folder the hub can open is added | ✅ in CI |
| `[TC-RT-1225-02]`, `[TC-RT-1225-03]` | A folder the hub can't open is refused, as a hob's folder and in setup, and only the macOS wording names System Settings | ✅ in CI on Linux as a non-root user, on `5ceab94` and on the PR's last commit; they skip as root |
| `[TC-RT-1219-02]` | `/usr/bin/git` and `/usr/bin/python3` run in the real Seatbelt sandbox with no `xcrun_db` error, and a write into the cache folder is refused | ✅ on the same Mac, from source |

## Gaps

- Allow on the shared-folder path was not run on `5ceab94`, and neither were the turns. It uses the same check as a hob's own folder, which passed. ([#1225](https://github.com/otaviobarros/hobbots/issues/1225))
- While macOS's prompt is on screen, the request that adds the folder stays open (2 minutes 24 seconds in one run), and the app does not say it is waiting on macOS. ([#1225](https://github.com/otaviobarros/hobbots/issues/1225))
- An ad hoc signed build asks again after each update, because macOS ties the decision to the build. A Developer ID signature would keep it, and was not run.
- No screenshot of the prompt: the run had no screen-recording access.
- The xcrun cache fix holds while `xcrun_db` is present and current. A missing or stale cache, or `xcrun_nocache=1`, still prints the error. ([#1219](https://github.com/otaviobarros/hobbots/issues/1219))
