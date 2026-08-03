'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';

function SidebarChrome({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const searchParams = useSearchParams();
  const product = searchParams.get('product');
  const job = searchParams.get('job');
  const onProducts = !product && !job;

  return (
    <>
      {open ? (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={onClose}
        />
      ) : null}
      <aside
        id="app-sidebar"
        className={`sidebar${open ? ' is-open' : ''}`}
        aria-label="App"
      >
        <div className="sidebar-brand">
          <a href="/">orch</a>
        </div>
        <nav className="sidebar-nav" role="navigation" aria-label="Primary">
          <a
            href="/"
            className={`sidebar-link${onProducts ? ' is-active' : ''}`}
          >
            Products
          </a>
        </nav>
        {(product || job) && (
          <div className="sidebar-crumbs breadcrumbs" aria-label="Context">
            <div className="sidebar-crumbs-label">Context</div>
            {product ? (
              <div className="crumb breadcrumb">
                <span className="crumb-meta">Product</span>
                <a href={`/?product=${encodeURIComponent(product)}`}>
                  {product}
                </a>
              </div>
            ) : null}
            {job ? (
              <div className="crumb breadcrumb">
                <span className="crumb-meta">Job</span>
                <a href={`/?job=${encodeURIComponent(job)}`}>{job}</a>
                {product ? (
                  <a
                    className="crumb-meta"
                    href={`/?product=${encodeURIComponent(product)}`}
                  >
                    ← back to product
                  </a>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </aside>
    </>
  );
}

export function AppChrome({ children }: { children: React.ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="app-shell">
      <div className="mobile-topbar">
        <div className="sidebar-brand">
          <a href="/">orch</a>
        </div>
        <button
          type="button"
          className="sidebar-toggle"
          aria-expanded={navOpen}
          aria-controls="app-sidebar"
          onClick={() => setNavOpen((v) => !v)}
        >
          Menu
        </button>
      </div>
      <Suspense fallback={<aside className="sidebar" aria-hidden />}>
        <SidebarChrome open={navOpen} onClose={() => setNavOpen(false)} />
      </Suspense>
      <main className="main">
        <div className="shell">{children}</div>
      </main>
    </div>
  );
}
