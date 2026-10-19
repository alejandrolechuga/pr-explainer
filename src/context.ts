// Everything the explainer knows about a PR besides the diff. Written by `gather`, read by `validate`.

export interface PrContext {
  version: 1;
  repo: string; // owner/name, or the folder name for a local branch
  pr: { number?: number; title: string; base: string; head: string; url?: string; headSha?: string; baseSha?: string };
  body: string;
  intentRecord: string | null;
  commits: { sha: string; message: string }[];
  issueRefs: string[];
  /** Issue text added by the skill from the issue tracker, keyed by id. */
  issues: { id: string; title: string; body: string }[];
  /** Decision and status docs from the head of the branch. */
  docs: { path: string; text: string }[];
}
