import { formatList } from "../../lib/format.ts";

/**
 * What a hob did or wants to do, in everyday words (STD-I18N-001): the Quest room's lanes and the
 * approval cards say these, and the exact commands stay in the Workbench Terminal and the card's code.
 */
export const messages = {
  /** Up to two file names, then how many more. */
  files: (names: ReadonlyArray<string>, more: number) =>
    more === 0 ? formatList(names) : formatList([...names, more === 1 ? "1 more file" : `${more} more files`]),
  someFiles: "some files",
  /** What a call on files wants to do, as the rest of "Ada asks to …" or a question, lower case. */
  action: {
    "read-files": ({ what }: { what: string }) => `read ${what}`,
    "edit-files": ({ what }: { what: string }) => `change ${what}`,
    "delete-files": ({ what }: { what: string }) => `delete ${what}`,
    "outside-folders": ({ what }: { what: string }) => `reach ${what}, outside its folders`,
  },
  /** An approval's plain question: "Delete scratch.txt?" */
  question: ({ what }: { what: string }) => `${what}?`,
  /** A step that runs now, by what it does. */
  doing: {
    "read-files": ({ what }: { what: string }) => `Reading ${what}`,
    "edit-files": ({ what }: { what: string }) => `Writing ${what}`,
    "delete-files": ({ what }: { what: string }) => `Deleting ${what}`,
    "local-git": "Saving the work with git",
    push: "Pushing the work",
    "use-web": "Looking something up on the web",
    "read-github": "Reading GitHub",
    "open-pull-request": "Opening a pull request",
    "comment-github": "Commenting on GitHub",
    "outside-folders": "Working outside its folders",
  },
  /** A command that only looks around, while it runs. */
  looking: "Looking through the files",
  /** A command, by what it does; the rest of "Ada asks to …", or a lane's line once capitalized. */
  command: {
    script: ({ name }: { name: string }) => `run ${name}`,
    tests: "run the tests",
    build: "build the project",
    lint: "check the code style",
    install: "install what the project needs",
    packageScript: ({ name }: { name: string }) => `run ${name}`,
    commit: "save the work in git",
    git: "use git",
    other: "run a command",
  },
  /** A command that ran, for a lane. */
  ran: {
    script: ({ name }: { name: string }) => `Ran ${name}`,
    tests: "Ran the tests",
    build: "Built the project",
    lint: "Checked the code style",
    install: "Installed what the project needs",
    packageScript: ({ name }: { name: string }) => `Ran ${name}`,
    commit: "Saved the work in git",
    git: "Used git",
    other: "Ran a command",
  },
  /** A command that runs now, for a lane. */
  running: {
    script: ({ name }: { name: string }) => `Running ${name}`,
    tests: "Running the tests",
    build: "Building the project",
    lint: "Checking the code style",
    install: "Installing what the project needs",
    packageScript: ({ name }: { name: string }) => `Running ${name}`,
    commit: "Saving the work in git",
    git: "Using git",
    other: "Running a command",
  },
  /** A file change, for a lane. */
  created: ({ name }: { name: string }) => `Created ${name}`,
  updated: ({ name }: { name: string }) => `Updated ${name}`,
  deleted: ({ name }: { name: string }) => `Deleted ${name}`,
  moved: ({ name }: { name: string }) => `Moved ${name}`,
  /** A step the safety policy, you or the sandbox stopped, for a lane. */
  blocked: {
    user: ({ what }: { what: string }) => `You said no to: ${what}`,
    policy: ({ what }: { what: string }) => `Not allowed to ${what}`,
    sandbox: ({ what }: { what: string }) => `The sandbox stopped it: ${what}`,
    outside: "Stopped a step that could reach outside its folders",
  },
  /** A step's outcome beside its words, for a screen reader; the glyph is decorative. */
  outcome: {
    done: "done",
    failed: "did not work",
    running: "running",
    blocked: "stopped",
    unknown: "not known how it went",
  },
};
