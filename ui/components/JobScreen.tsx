'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, apiText, ApiError } from '@/lib/api';
import type { FileEntry, Job } from '@/lib/types';

type Props = {
  jobSlug: string;
};

export function JobScreen({ jobSlug }: Props) {
  const [job, setJob] = useState<Job | null>(null);
  const [logs, setLogs] = useState('');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [controlBusy, setControlBusy] = useState(false);

  async function loadJob() {
    const { data } = await api<{ job: Job }>(
      `/api/jobs/${encodeURIComponent(jobSlug)}`,
    );
    setJob(data.job);
  }

  async function loadLogs() {
    const text = await apiText(`/api/jobs/${encodeURIComponent(jobSlug)}/logs`);
    setLogs(text);
  }

  async function loadFiles() {
    const { data } = await api<{ files: FileEntry[] }>(
      `/api/jobs/${encodeURIComponent(jobSlug)}/files`,
    );
    setFiles(data.files || []);
  }

  const refreshAll = useCallback(async () => {
    setError(null);
    try {
      await Promise.all([loadJob(), loadLogs(), loadFiles()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to load job');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loaders close over jobSlug
  }, [jobSlug]);

  useEffect(() => {
    void refreshAll();
    const timer = setInterval(() => {
      void loadJob().catch(() => {
        /* keep last known status on poll errors */
      });
      void loadLogs().catch(() => {
        /* keep last known logs on poll errors */
      });
    }, 2500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll loadJob/loadLogs for status/prUrl/logs
  }, [jobSlug, refreshAll]);

  async function control(action: 'pause' | 'resume' | 'stop') {
    setControlBusy(true);
    setError(null);
    try {
      const path =
        action === 'pause'
          ? `/api/jobs/${encodeURIComponent(jobSlug)}/pause`
          : action === 'resume'
            ? `/api/jobs/${encodeURIComponent(jobSlug)}/resume`
            : `/api/jobs/${encodeURIComponent(jobSlug)}/stop`;
      const { data } = await api<{ job: Job }>(path, { method: 'POST' });
      if (data.job) setJob(data.job);
      else await loadJob();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `${action} failed`);
    } finally {
      setControlBusy(false);
    }
  }

  const productHref = job?.product
    ? `/?product=${encodeURIComponent(String(job.product))}`
    : '/';

  return (
    <div>
      <div className="card">
        <p className="muted">
          <Link href={productHref}>← Product</Link>
          {' · '}
          <Link href="/">Products</Link>
        </p>
        <h2 className="mono">{jobSlug}</h2>
        <div className="row" style={{ marginTop: '0.5rem' }}>
          <span className="badge">{job?.state || '…'}</span>
          <button type="button" className="secondary" onClick={loadJob}>
            Refresh
          </button>
        </div>
        {job?.prUrl ? (
          <p style={{ marginTop: '0.75rem' }}>
            PR:{' '}
            <a href={job.prUrl} target="_blank" rel="noreferrer">
              {job.prUrl}
            </a>
          </p>
        ) : (
          <p className="muted" style={{ marginTop: '0.75rem' }}>
            No PR URL yet.
          </p>
        )}
      </div>

      <div className="card">
        <h3>Controls</h3>
        <div className="row">
          <button type="button" className="secondary" disabled={controlBusy} onClick={() => control('pause')}>
            Pause
          </button>
          <button type="button" className="secondary" disabled={controlBusy} onClick={() => control('resume')}>
            Resume
          </button>
          <button type="button" className="danger" disabled={controlBusy} onClick={() => control('stop')}>
            Stop
          </button>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Logs</h3>
          <button type="button" className="secondary" onClick={() => void loadLogs()}>
            Reload logs
          </button>
        </div>
        <pre className="logs" style={{ marginTop: '0.75rem' }}>
          {logs || '(empty)'}
        </pre>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Files</h3>
          <button type="button" className="secondary" onClick={() => void loadFiles()}>
            Reload files
          </button>
        </div>
        {files.length === 0 ? (
          <p className="muted" style={{ marginTop: '0.75rem' }}>
            No files changed.
          </p>
        ) : (
          <ul className="files" style={{ marginTop: '0.75rem' }}>
            {files.map((file) => (
              <li key={`${file.path}:${file.status}`}>
                <span>{file.path}</span>
                <span className="badge">{file.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
