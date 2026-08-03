'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import type { Product } from '@/lib/types';

type Props = {
  onOpenProduct: (slug: string) => void;
};

export function ProductsScreen({ onOpenProduct }: Props) {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [initName, setInitName] = useState('');
  const [initSlug, setInitSlug] = useState('');
  const [initOwner, setInitOwner] = useState('');
  const [initBusy, setInitBusy] = useState(false);

  const [cloneName, setCloneName] = useState('');
  const [cloneSlug, setCloneSlug] = useState('');
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneBusy, setCloneBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { data } = await api<{ products: Product[] }>('/api/products');
      setProducts(data.products || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to load products');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createInit(e: FormEvent) {
    e.preventDefault();
    setInitBusy(true);
    setError(null);
    try {
      const body: { name: string; slug: string; source: 'init'; owner?: string } = {
        name: initName.trim(),
        slug: initSlug.trim(),
        source: 'init',
      };
      const owner = initOwner.trim();
      if (owner) body.owner = owner;

      const res = await api<{ product: Product }>('/api/products', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (res.status === 201) {
        const slug = res.data.product?.slug || body.slug;
        router.push(`/?product=${encodeURIComponent(slug)}`);
        onOpenProduct(slug);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'init failed');
    } finally {
      setInitBusy(false);
    }
  }

  async function createClone(e: FormEvent) {
    e.preventDefault();
    setCloneBusy(true);
    setError(null);
    try {
      const body = {
        name: cloneName.trim(),
        slug: cloneSlug.trim(),
        source: 'clone' as const,
        url: cloneUrl.trim(),
      };
      const res = await api<{ product: Product }>('/api/products', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (res.status === 201) {
        const slug = res.data.product?.slug || body.slug;
        router.push(`/?product=${encodeURIComponent(slug)}`);
        onOpenProduct(slug);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'clone failed');
    } finally {
      setCloneBusy(false);
    }
  }

  return (
    <div>
      <div className="card">
        <h2>Products</h2>
        {loading ? <p className="muted">Loading…</p> : null}
        {!loading && products.length === 0 ? (
          <p className="muted">No products yet.</p>
        ) : null}
        <ul className="list">
          {products.map((p) => (
            <li key={p.slug}>
              <a
                href={`/?product=${encodeURIComponent(p.slug)}`}
                onClick={(ev) => {
                  ev.preventDefault();
                  onOpenProduct(p.slug);
                }}
              >
                <strong>{p.name || p.slug}</strong>
              </a>
              <div className="meta mono">{p.slug}</div>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h2>New blank</h2>
        <form className="stack" onSubmit={createInit}>
          <label>
            Name
            <input
              value={initName}
              onChange={(e) => setInitName(e.target.value)}
              required
              autoComplete="off"
            />
          </label>
          <label>
            Slug
            <input
              value={initSlug}
              onChange={(e) => setInitSlug(e.target.value)}
              required
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              maxLength={64}
              autoComplete="off"
            />
          </label>
          <label>
            Owner (optional)
            <input
              value={initOwner}
              onChange={(e) => setInitOwner(e.target.value)}
              autoComplete="off"
            />
          </label>
          <button type="submit" disabled={initBusy}>
            {initBusy ? 'Creating…' : 'Create blank'}
          </button>
        </form>
      </div>

      <div className="card">
        <h2>Clone from GitHub</h2>
        <form className="stack" onSubmit={createClone}>
          <label>
            Name
            <input
              value={cloneName}
              onChange={(e) => setCloneName(e.target.value)}
              required
              autoComplete="off"
            />
          </label>
          <label>
            Slug
            <input
              value={cloneSlug}
              onChange={(e) => setCloneSlug(e.target.value)}
              required
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              maxLength={64}
              autoComplete="off"
            />
          </label>
          <label>
            URL
            <input
              value={cloneUrl}
              onChange={(e) => setCloneUrl(e.target.value)}
              required
              type="text"
              placeholder="git@github.com:owner/repo.git"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button type="submit" disabled={cloneBusy}>
            {cloneBusy ? 'Cloning…' : 'Clone'}
          </button>
        </form>
      </div>

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
