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

/** One turn in a read-only ask session thread. */
export type AskTurn = {
  role: 'user' | 'assistant' | string;
  content: string;
  at?: string;
};

/** Persistable ask session returned by serve ask start/continue/GET. */
export type AskSession = {
  slug: string;
  createdAt?: string;
  updatedAt?: string;
  agent?: string;
  turns: AskTurn[];
};

/** POST /api/products/:product/ask response (read-only ask; no job queue). */
export type AskResponse = {
  slug: string;
  answer: string;
  session?: AskSession;
};
