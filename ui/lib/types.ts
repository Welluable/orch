export type Product = {
  slug: string;
  name: string;
  owner?: string;
  url?: string;
  source?: string;
  [key: string]: unknown;
};

/** Serve Run modes: omit / default = normal pipeline. */
export type JobMode = 'seq' | 'fan-out';

export type Job = {
  slug: string;
  state?: string;
  prUrl?: string | null;
  product?: string;
  prompt?: string;
  mode?: JobMode;
  [key: string]: unknown;
};

export type CreateJobRequest = {
  task: string;
  id: string;
  mode?: JobMode;
  agent?: string;
  maxRounds?: number;
};

export type FileEntry = {
  path: string;
  status: string;
};

/** POST /api/products/:product/ask response (read-only ask; no job queue). */
export type AskResponse = {
  slug: string;
  answer: string;
  session?: unknown;
};
