'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import type { Job, Product } from '@/lib/types';

type Props = {
  productSlug: string;
};

export function ProductScreen({ productSlug }: Props) {
  const [product, setProduct] = useState<Product | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [task, setTask] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { data } = await api<{ product: Product; jobs?: Job[] }>(
        `/api/products/${encodeURIComponent(productSlug)}`,
      );
      setProduct(data.product);
      setJobs(data.jobs || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to load product');
    } finally {
      setLoading(false);
    }
  }, [productSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runJob(e: FormEvent) {
    e.preventDefault();
    const trimmed = task.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const id = crypto.randomUUID();
      await api<{ slug: string; job: Job }>(
        `/api/products/${encodeURIComponent(productSlug)}/jobs`,
        {
          method: 'POST',
          body: JSON.stringify({ task: trimmed, id }),
        },
      );
      setTask('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'run failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="card">
        <p className="muted">
          <Link href="/">← Products</Link>
        </p>
        <h2>{product?.name || productSlug}</h2>
        <p className="meta mono">{productSlug}</p>
        {loading ? <p className="muted">Loading…</p> : null}
      </div>

      <div className="card">
        <h3>Run</h3>
        <form className="stack" onSubmit={runJob}>
          <label>
            Task
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              required
              placeholder="Describe the work…"
            />
          </label>
          <button type="submit" disabled={busy || !task.trim()}>
            {busy ? 'Starting…' : 'Run'}
          </button>
        </form>
      </div>

      <div className="card">
        <h3>Jobs</h3>
        {jobs.length === 0 ? <p className="muted">No jobs yet.</p> : null}
        <ul className="list">
          {jobs.map((job) => (
            <li key={job.slug}>
              <Link href={`/?job=${encodeURIComponent(job.slug)}`}>
                <strong className="mono">{job.slug}</strong>
              </Link>
              <div className="meta">
                <span className="badge">{job.state || 'unknown'}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
