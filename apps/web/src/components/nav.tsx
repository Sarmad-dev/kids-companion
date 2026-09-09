'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The sidebar.
 *
 * The only client component in the shell — it needs the current path to mark the
 * active link, and that is the whole reason. Everything else renders on the
 * server, which is what keeps the session token out of the browser bundle.
 *
 * `aria-current="page"` rather than a class alone: a screen-reader user needs to
 * know where they are, and a background colour does not tell them.
 */

const AREAS = [
  ['/dashboard', 'Dashboard'],
  ['/children', 'Children'],
  ['/progress', 'Progress'],
  ['/conversations', 'Conversations'],
  ['/practice', 'Speech practice'],
  ['/controls', 'Parental controls'],
  ['/subscription', 'Subscription'],
  ['/notifications', 'Notifications'],
  ['/account', 'Account'],
  ['/privacy', 'Privacy'],
] as const;

export const Nav = () => {
  const pathname = usePathname();

  return (
    <nav className="nav" aria-label="Dashboard sections">
      {AREAS.map(([href, label]) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link key={href} href={href} {...(active ? { 'aria-current': 'page' as const } : {})}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
};
