export type Product = {
  slug: string;
  name: string;
  owner?: string;
  url?: string;
  source?: string;
  [key: string]: unknown;
};

/** Serve Run modes: omit / default = normal pipeline. */
export type JobMode = 'seq' | 'fan-out' | 'decompose';

/** Unit from serve `job.seq` enrichment (`seqEnrichment`). */
export type JobSeqUnit = {
  id: string;
  title?: string;
  subtask?: string;
  state?: string;
  slug?: string | null;
  childSlug?: string | null;
};

/** Plan/execute backlog attached when seq.json exists for the job. */
export type JobSeq = {
  state?: string;
  units: JobSeqUnit[];
};

export type Job = {
  slug: string;
  state?: string;
  prUrl?: string | null;
  product?: string;
  prompt?: string;
  mode?: JobMode;
  seq?: JobSeq;
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
