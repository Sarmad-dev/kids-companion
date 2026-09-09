import Link from 'next/link';
import type { ReactNode } from 'react';

import { Nav } from '../../components/nav';
import { requireParent } from '../../lib/session';

/**
 * The dashboard shell.
 *
 * `requireParent()` runs here, on the server, before any page beneath it
 * renders. That is the whole authentication story for this surface: one check,
 * in one place, that cannot be forgotten on a new page.
 *
 * It is NOT the authorisation story. It decides whether to draw a dashboard, not
 * which children appear on it — the API decides that, and RLS decides it again.
 * A parent who edited this layout out of their own browser would see an empty
 * shell, because the data never arrives from here.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  await requireParent();

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <aside className="sidebar">
        <Link className="brand" href="/dashboard">
          kids-companion
        </Link>
        <Nav />
      </aside>

      <main className="main" id="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
