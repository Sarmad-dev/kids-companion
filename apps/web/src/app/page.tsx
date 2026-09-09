import { redirect } from 'next/navigation';

import { readSession } from '../lib/session';

/**
 * The front door.
 *
 * There is no marketing page here yet and no child experience on the web at all,
 * so `/` is a decision rather than a destination: a signed-in parent goes to
 * their dashboard, everyone else goes to sign in.
 *
 * Dynamic because it reads a cookie. Rendering this at build time would send
 * every visitor to whichever branch happened to be true when it was built.
 */
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = await readSession();
  redirect(session ? '/dashboard' : '/login');
}
