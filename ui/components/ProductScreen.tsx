'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { v4 as uuidv4 } from 'uuid';
import { api, ApiError } from '@/lib/api';
import type { Job, JobMode, Product } from '@/lib/types';

type Props = {
  productSlug: string;
};

type RunMode = 'default' | JobMode;

export function ProductScreen({ productSlug }: Props) {
  const [product, setProduct] = useState<Product | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [task, setTask] = useState('');
  const [mode, setMode] = useState<RunMode>('default');
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
      const id = uuidv4();
      const body: { task: string; id: string; mode?: JobMode } = {
        task: trimmed,
        id,
      };
      if (mode === 'seq' || mode === 'fan-out' || mode === 'decompose') {
        body.mode = mode;
      }
      await api<{ slug: string; job: Job }>(
        `/api/products/${encodeURIComponent(productSlug)}/jobs`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      );
      setTask('');
      setMode('default');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'run failed');
    } finally {
      setBusy(false);
    }
  }

  async function cleanAllJobs() {
    if (
      !window.confirm(
        'Clean all jobs for this product? This cannot be undone.',
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api<{ ok: boolean; removed: string[] }>(
        `/api/products/${encodeURIComponent(productSlug)}/jobs/clean`,
        { method: 'POST' },
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'clean failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <p className="muted back-link">
            <Link href="/">← Products</Link>
          </p>
          <h1 className="page-title">{product?.name || productSlug}</h1>
          <p className="page-subtitle mono">{productSlug}</p>
          {loading ? <p className="muted">Loading…</p> : null}
        </div>
      </header>

      <section className="section-panel">
        <h2>Run</h2>
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
          <fieldset className="mode-fieldset">
            <legend>Mode</legend>
            <div className="row mode-options" role="radiogroup" aria-label="Run mode">
              <label className="mode-option">
                <input
                  type="radio"
                  name="mode"
                  value="default"
                  checked={mode === 'default'}
                  onChange={() => setMode('default')}
                />
                Default
              </label>
              <label className="mode-option">
                <input
                  type="radio"
                  name="mode"
                  value="seq"
                  checked={mode === 'seq'}
                  onChange={() => setMode('seq')}
                />
                SEQ
              </label>
              <label className="mode-option">
                <input
                  type="radio"
                  name="mode"
                  value="fan-out"
                  checked={mode === 'fan-out'}
                  onChange={() => setMode('fan-out')}
                />
                Fan out
              </label>
              <label className="mode-option">
                <input
                  type="radio"
                  name="mode"
                  value="decompose"
                  checked={mode === 'decompose'}
                  onChange={() => setMode('decompose')}
                />
                Decompose
              </label>
            </div>
          </fieldset>
          <button type="submit" disabled={busy || !task.trim()}>
            {busy ? 'Starting…' : 'Run'}
          </button>
        </form>
      </section>

      <section className="section-panel">
        <div className="row row-between">
          <h2 className="section-heading">Jobs</h2>
          <button
            type="button"
            className="danger"
            disabled={busy || loading || jobs.length === 0}
            onClick={() => void cleanAllJobs()}
          >
            Clean jobs
          </button>
        </div>
        {jobs.length === 0 ? <p className="muted">No jobs yet.</p> : null}
        <ul className="list">
          {jobs.map((job) => (
            <li key={job.slug} className="list-row job-row">
              <div>
                <Link
                  href={`/?product=${encodeURIComponent(productSlug)}&job=${encodeURIComponent(job.slug)}`}
                >
                  <strong className="mono">{job.slug}</strong>
                </Link>
              </div>
              <span className="badge">{job.state || 'unknown'}</span>
            </li>
          ))}
        </ul>
      </section>

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
