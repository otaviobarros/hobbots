/** User-facing copy for the screens a route shows when it fails (STD-I18N-001, STD-UI-009). */
export const messages = {
  pageTitle: "This page could not open",
  appTitle: "Hobbots could not open",
  body: {
    unreachable:
      "Hobbots cannot reach the hub right now. It may be off, or remote access may be paused. Your hobs keep their work, so try again once the hub is back.",
    missing: "What this page shows is no longer on the hub. It may have been archived, retired or deleted.",
    unknown:
      "Something went wrong while opening it. Your hobs keep working on the hub. Try again, or go somewhere else for now.",
  },
  tryAgain: "Try again",
  tryingAgain: "Trying again…",
  reload: "Reload Hobbots",
  ways: {
    home: "Go to Home",
    hobs: "Go to Your hobs",
    inbox: "Go to the Inbox",
    archive: "Go to the Archive",
    settings: "Go to Settings",
    welcome: "Back to Welcome",
  },
} as const;
