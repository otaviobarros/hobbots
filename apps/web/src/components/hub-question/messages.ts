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
