import type { Metadata, Viewport } from 'next';
import { Suspense } from 'react';
import { AppChrome } from '@/components/AppChrome';
import './globals.css';

export const metadata: Metadata = {
  title: 'orch',
  description: 'orch products and jobs',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Suspense fallback={<div className="app-shell"><main className="main">{children}</main></div>}>
          <AppChrome>{children}</AppChrome>
        </Suspense>
      </body>
    </html>
  );
}
