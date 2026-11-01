/** User-facing copy for formatted hob replies (STD-I18N-001). */
export const messages = {
  code: {
    label: ({ language }: { language: string }) => `${language} code`,
    plain: "Code",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Could not copy",
  },
  link: {
    /** The address beside a link, so the reader sees where it goes before opening it. */
    address: ({ url }: { url: string }) => `(${url})`,
    opensOutside: ({ url }: { url: string }) => `Opens ${url} in your browser`,
  },
  image: {
    load: ({ host }: { host: string }) => `Show image from ${host}`,
    loadNamed: ({ alt, host }: { alt: string; host: string }) => `Show image “${alt}” from ${host}`,
  },
};
