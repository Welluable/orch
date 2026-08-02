'use client';

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ProductsScreen } from '@/components/ProductsScreen';
import { ProductScreen } from '@/components/ProductScreen';
import { JobScreen } from '@/components/JobScreen';

function AppRouter() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const job = searchParams.get('job');
  const product = searchParams.get('product');

  function openProduct(slug: string) {
    router.push(`/?product=${encodeURIComponent(slug)}`);
  }

  if (job) {
    return <JobScreen jobSlug={job} />;
  }
  if (product) {
    return <ProductScreen productSlug={product} />;
  }
  return <ProductsScreen onOpenProduct={openProduct} />;
}

export default function HomePage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <AppRouter />
    </Suspense>
  );
}
