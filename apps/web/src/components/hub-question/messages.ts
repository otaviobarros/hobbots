/**
 * User-facing copy for the questions the hub itself asks you (#976, STD-I18N-001). The hub sends
 * each one as a kind, codes and data (#1045); these turn them into words.
 */
export const messages = {
  commitIdentity: {
    title: "Who hobs commit as",
    reason: {
      "no-git-identity":
        "Your Git config sets no name and email, so hobs that commit as you can't commit, and they may not set one themselves.",
      "unreadable-answer": ({ unread }: { unread: string }) => `Hobbots couldn't find a name and email in "${unread}".`,
    },
    pickOrType: ({ example }: { example: string }) =>
      `Who should hobs commit as? Pick one, or type a name and email, such as ${example}.`,
    typeOrSet: ({ example }: { example: string }) =>
      `Who should hobs commit as? Type a name and email, such as ${example}. Or set user.name and user.email with git config --global on the hub's computer, then answer "done".`,
    example: "Ada Lovelace <ada@example.com>",
    github: {
      label: ({ login }: { login: string }) => `My GitHub account, @${login}`,
      consequence: ({ name, email }: { name: string; email: string }) =>
        `Commits are made as ${name} <${email}>, which GitHub links to your account.`,
    },
    ownGit: {
      label: "I'll set it in Git myself",
      consequence:
        "Run git config --global user.name and user.email on the hub's computer. Hobs use them from their next turn.",
    },
  },
  /** Whether a hob will write code (#1241), in words for someone who may not code. */
  codingSetup: {
    title: ({ hob }: { hob: string }) => `Coding setup for ${hob}`,
    text: ({ hob }: { hob: string }) =>
      `Will ${hob} write code?\n\nIf ${hob} will work on code, link a GitHub account so its changes are saved under a name. It takes a minute in the GitHub section of ${hob}'s profile.\n\nIf ${hob} is just for writing, research or chatting, you don't need this.`,
    notThisHob: ({ hob }: { hob: string }) => ({
      label: `Not for ${hob}`,
      consequence: `Hobbots won't ask about ${hob} again.`,
    }),
    noHob: {
      label: "Don't ask for any hob",
      consequence: "Hobbots won't ask about any hob. You can turn it back on in Settings › Connections › Charms.",
    },
  },
  /** The made-up questions the hub asks for trying hub questions out. */
  fakeCheck: {
    backups: { title: "Nightly backups", text: "How often should the hub back up your data?" },
    hubName: { title: "The hub's name", text: "What should this hub be called on your other devices?" },
    applied: {
      title: "What the hub applied",
      text: ({ applied }: { applied: string }) => `The hub applied: ${applied}`,
    },
    nightly: { label: "Every night", consequence: "A backup each night, kept for a week." },
    weekly: { label: "Every week", consequence: "A backup each Sunday, kept for a month." },
  },
} as const;
