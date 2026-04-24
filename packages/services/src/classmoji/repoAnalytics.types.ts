export type CommitRecord = {
  sha: string;
  author_login: string | null;
  author_email: string | null;
  author_user_id: string | null;
  ts: string; // ISO
  message: string;
  additions: number;
  deletions: number;
  parents: string[];
};

export type ContributorRecord = {
  login: string;
  user_id: string | null;
  commits: number;
  additions: number;
  deletions: number;
};

export type LanguagesMap = Record<string, number>;

export type PRSummary = { open: number; merged: number; closed: number };

export type SnapshotPayload = {
  commits: CommitRecord[];
  contributors: ContributorRecord[];
  languages: LanguagesMap;
  pr_summary: PRSummary;
};
