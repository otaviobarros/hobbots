/** User-facing copy for the Settings sections in this folder (STD-I18N-001). */
export const messages = {
  thisApp: {
    heading: "This app",
    starts: "When Hobbots starts",
    notifications: "Notifications",
  },
  motion: {
    label: "Reduce motion",
    followsSystem: "Fewer animations. Hobs stand still instead of hopping. Follows your system setting on this device.",
    setHereSystemOn:
      "Fewer animations. Hobs stand still instead of hopping. Set on this device. Your system setting is on.",
    setHereSystemOff:
      "Fewer animations. Hobs stand still instead of hopping. Set on this device. Your system setting is off.",
    useSystem: "Use the system setting",
  },
  notifications: {
    requests: {
      label: "When a hob needs me",
      note: "Approvals a hob waits on, while no Hobbots window is in front. Recommended.",
    },
    devices: { label: "When a device asks to connect", note: "A phone or computer asking to use this hub." },
    sound: { label: "Play a sound", note: "The system sound with each notification." },
    failed: "Hobbots could not read or change its notifications. Try again.",
    systemSettings: "macOS can also silence Hobbots in System Settings › Notifications.",
    elsewhere: "Notifications come from the Hobbots app on the Mac that runs your hub, and are set there.",
  },
  about: {
    heading: "Help and about",
    failed: "Hobbots could not read the hub's details. Try again in a moment.",
    version: "Version",
    release: ({ version }: { version: string }) => `Hobbots ${version}`,
    development: "Development build",
    hub: "Hub",
    thisComputer: "This computer",
    dataFolder: "Data folder",
    dataFolderElsewhere: "Shown only on the hub's own computer.",
    copy: { idle: "Copy", copied: "Copied", failed: "Could not copy" },
    licenses: "Licenses",
    license: "Apache License 2.0",
    libraries: "Open-source libraries",
    openSource: "Hobbots is free and open source.",
    repository: "Read the code, report a bug or suggest a hob on GitHub",
  },
} as const;

/** A checkout's server reports `development` rather than a release number. */
export const versionLabel = (version: string): string =>
  version === "development" ? messages.about.development : messages.about.release({ version });
