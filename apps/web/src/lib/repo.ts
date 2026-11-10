// A Hugging Face repo, as people paste it: "owner/name", a full link, or a link into the file tree.

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
