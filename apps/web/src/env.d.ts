/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" swaps the network for the in-browser mock gateway. */
  readonly VITE_MOCK?: string;
}

/** Built by scripts/vite-docs.ts from docs/site/*.md (and the app's stand-in pages). */
declare module "virtual:docs" {
  export const index: import("./lib/frontmatter").DocMeta[];
  export const files: string[];
  export const loaders: Record<string, () => Promise<string>>;
}
