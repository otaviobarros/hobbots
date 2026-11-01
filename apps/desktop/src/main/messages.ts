/** User-facing copy for the desktop app's main process, grouped by feature (STD-I18N-001). */
export const messages = {
  requestNotice: {
    title: ({ name }: { name: string }) => `${name} asks permission`,
    unknownHob: "A hob",
  },
} as const;
