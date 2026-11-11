// A Hugging Face repo, as people paste it: "owner/name", a full link, or a link into the file tree.

/** What the check says under a model that is loaded already: the caller's own private copy, or the catalog's model. */
export const loadedNote = (own: boolean): string =>
  `${own ? "This is your private copy, loaded already. Only this account sees it." : "This model is in the catalog already."} It wakes like any other, with no first load.`;

/** The cap of a first load and its estimate are shown only for a model that would get one, never for a loaded one. */
export const firstLoadShown = (state: string): boolean => state !== "loaded";

const NAME = /^[\w.-]+\/[\w.-]+$/;

/** "owner/name" from pasted text, or null when it is not a repo. */
export function parseRepo(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\//i, "");
  s = s.replace(/[?#].*$/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const repo = `${parts[0]}/${parts[1]}`;
  // Anything after owner/name must be a known sub-path of a model page, not a third name segment.
  if (parts.length > 2 && !["tree", "blob", "resolve", "discussions", "commits"].includes(parts[2]!)) return null;
  return NAME.test(repo) ? repo : null;
}
