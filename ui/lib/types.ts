export type Product = {
  slug: string;
  name: string;
  owner?: string;
  url?: string;
  source?: string;
  [key: string]: unknown;
};

export type Job = {
  slug: string;
  state?: string;
  prUrl?: string | null;
  product?: string;
  prompt?: string;
  [key: string]: unknown;
};

export type FileEntry = {
  path: string;
  status: string;
};
