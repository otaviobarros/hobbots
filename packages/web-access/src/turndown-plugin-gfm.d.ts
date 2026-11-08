// The package ships no types (its README asks for this declaration).
declare module "@joplin/turndown-plugin-gfm" {
  import type TurndownService from "turndown";

  export const tables: TurndownService.Plugin;
}
