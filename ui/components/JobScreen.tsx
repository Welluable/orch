'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
  const logsRef = useRef<HTMLPreElement>(null);

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
      void loadFiles().catch(() => {
        /* keep last known files on poll errors */
      });
    }, 2500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll loadJob/loadLogs/loadFiles for status/prUrl/logs/files
  }, [jobSlug, refreshAll]);

  useEffect(() => {
    const el = logsRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logs]);

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
    <div className="job-console">
      <div className="job-console-sidebar">
        <header className="page-header">
          <div>
            <p className="muted back-link">
              <Link href={productHref}>← Product</Link>
              {' · '}
              <Link href="/">Products</Link>
            </p>
            <h1 className="page-title mono">{jobSlug}</h1>
            <div className="row mt-1">
              <span className="badge">{job?.state || '…'}</span>
              <button type="button" className="secondary" onClick={loadJob}>
                Refresh
              </button>
            </div>
            {job?.prUrl ? (
              <p className="mt-2">
                PR:{' '}
                <a href={job.prUrl} target="_blank" rel="noreferrer">
                  {job.prUrl}
                </a>
              </p>
            ) : (
              <p className="muted mt-2">
                No PR URL yet.
              </p>
            )}
          </div>
        </header>

        <section className="section-panel">
          <h3>Controls</h3>
          <div className="row">
            <button
              type="button"
              className="secondary"
              disabled={controlBusy}
              onClick={() => control('pause')}
            >
              Pause
            </button>
            <button
              type="button"
              className="secondary"
              disabled={controlBusy}
              onClick={() => control('resume')}
            >
              Resume
            </button>
            <button
              type="button"
              className="danger"
              disabled={controlBusy}
              onClick={() => control('stop')}
            >
              Stop
            </button>
          </div>
        </section>

        <section className="section-panel">
          <div className="row row-between">
            <h3 className="section-heading">Files</h3>
            <button type="button" className="secondary" onClick={() => void loadFiles()}>
              Reload files
            </button>
          </div>
          {files.length === 0 ? (
            <p className="muted mt-2">
              No files changed.
            </p>
          ) : (
            <ul className="files mt-2">
              {files.map((file) => (
                <li key={`${file.path}:${file.status}`} className="list-row">
                  <span>{file.path}</span>
                  <span className="badge">{file.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="logs-panel terminal">
        <div className="logs-toolbar">
          <h3>Logs</h3>
          <button type="button" className="secondary" onClick={() => void loadLogs()}>
            Reload logs
          </button>
        </div>
        <pre className="logs mono" ref={logsRef}>
          {logs || '(empty)'}
        </pre>
      </div>

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
