import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'kids-companion — parent dashboard',
  description: 'Manage profiles, review conversations, and control settings.',
  // This surface is for parents only; there is no child experience on the web.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
