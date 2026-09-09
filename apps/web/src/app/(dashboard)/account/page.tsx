import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import {
  Card,
  ErrorBanner,
  ErrorState,
  Field,
  InfoBanner,
  PageHeader,
  Pill,
  SuccessBanner,
} from '../../../components/ui';
import {
  changePassword,
  getParentProfile,
  getSignedInDevices,
  revokeAllSessions,
  updateProfile,
} from '../../../lib/api';
import { longDate } from '../../../lib/format';
import { text } from '../../../lib/forms';
import { SESSION_COOKIE_NAME } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * Account.
 *
 * Three things a parent needs to be able to do without contacting anyone: change
 * their details, change their password, and end every session if they think
 * someone else has it.
 *
 * The password form posts to a Server Action, so the old and new passwords go
 * from the browser to this server to the API and are never held in client
 * JavaScript. Changing a password revokes every session including this one — the
 * cookie is cleared here to match, because leaving a dead token in the browser
 * would look like a broken app.
 */

const ERRORS: Record<string, string> = {
  profile: 'We could not save your details. Please try again.',
  mismatch: 'The two new passwords did not match.',
  password:
    'We could not change your password. Check your current password and make sure the new one is long enough.',
};

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const [profile, devices] = await Promise.all([getParentProfile(), getSignedInDevices()]);

  if (profile.state !== 'ok') {
    return (
      <>
        <PageHeader title="Account" />
        <ErrorState
          message={profile.state === 'error' ? profile.message : 'Please sign in again.'}
        />
      </>
    );
  }

  const me = profile.data;
  const sessions =
    devices.state === 'ok' ? devices.data.items.filter((s) => s.revokedAt === null) : [];
  const saved = params.saved !== undefined;
  const failure = typeof params.error === 'string' ? ERRORS[params.error] : undefined;

  const saveProfile = async (formData: FormData): Promise<void> => {
    'use server';

    const displayName = text(formData, 'displayName').trim();
    const countryCode = text(formData, 'countryCode').toUpperCase().slice(0, 2);
    const locale = text(formData, 'locale');
    const timezone = text(formData, 'timezone').trim();

    const result = await updateProfile({
      displayName: displayName === '' ? null : displayName,
      countryCode: countryCode === '' ? 'PK' : countryCode,
      locale: locale === '' ? 'en' : locale,
      timezone: timezone === '' ? 'Asia/Karachi' : timezone,
    });

    if (result.state !== 'ok') redirect('/account?error=profile');

    revalidatePath('/account');
    redirect('/account?saved=profile');
  };

  const setPassword = async (formData: FormData): Promise<void> => {
    'use server';

    const current = text(formData, 'currentPassword');
    const next = text(formData, 'newPassword');
    const again = text(formData, 'confirmPassword');

    if (next !== again) redirect('/account?error=mismatch');

    const result = await changePassword(current, next);
    if (result.state !== 'ok') redirect('/account?error=password');

    // The API revoked every session, this one included. Clearing the cookie is
    // what makes that visible instead of mysterious.
    const store = await cookies();
    store.delete(SESSION_COOKIE_NAME);
    redirect('/login');
  };

  const endAllSessions = async (): Promise<void> => {
    'use server';

    await revokeAllSessions();
    const store = await cookies();
    store.delete(SESSION_COOKIE_NAME);
    redirect('/login');
  };

  const signOut = async (): Promise<void> => {
    'use server';

    const store = await cookies();
    store.delete(SESSION_COOKIE_NAME);
    redirect('/login');
  };

  return (
    <>
      <PageHeader
        title="Account"
        description="Your details and your sign-ins. Nothing here is visible to your children."
        actions={
          <form action={signOut}>
            <button className="button button-secondary" type="submit">
              Sign out
            </button>
          </form>
        }
      />

      {saved && <SuccessBanner>Your details have been updated.</SuccessBanner>}
      {failure !== undefined && <ErrorBanner>{failure}</ErrorBanner>}

      <div className="stack">
        <Card title="Your details">
          <form action={saveProfile} className="stack">
            <Field
              label="Email address"
              htmlFor="email"
              hint="Used to sign in and for account emails. Contact us to change it."
            >
              <input id="email" type="email" value={me.email} readOnly disabled />
            </Field>

            <Field label="Your name" htmlFor="displayName" hint="Optional. Only you see it.">
              <input
                id="displayName"
                name="displayName"
                type="text"
                maxLength={80}
                defaultValue={me.displayName ?? ''}
              />
            </Field>

            <div className="row">
              <Field label="Country" htmlFor="countryCode" hint="Two letters, e.g. PK.">
                <input
                  id="countryCode"
                  name="countryCode"
                  type="text"
                  maxLength={2}
                  defaultValue={me.countryCode}
                />
              </Field>

              <Field label="Language" htmlFor="locale" hint="For emails and this dashboard.">
                <select id="locale" name="locale" defaultValue={me.locale}>
                  <option value="en">English</option>
                  <option value="ur">اردو</option>
                </select>
              </Field>
            </div>

            <Field
              label="Time zone"
              htmlFor="timezone"
              hint="Daily limits and quiet hours are worked out in this time zone."
            >
              <input
                id="timezone"
                name="timezone"
                type="text"
                maxLength={64}
                defaultValue={me.timezone}
              />
            </Field>

            <div className="row">
              <button className="button" type="submit">
                Save details
              </button>
            </div>
          </form>

          <p className="stat-caveat">
            Member since {longDate(me.createdAt)}.{' '}
            {me.emailVerified ? 'Email confirmed.' : 'Email not yet confirmed.'}
          </p>
        </Card>

        <Card title="Password">
          <form action={setPassword} className="stack">
            <Field label="Current password" htmlFor="currentPassword">
              <input
                id="currentPassword"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            <Field
              label="New password"
              htmlFor="newPassword"
              hint="At least 12 characters. A short sentence you will remember beats a short jumble you will not."
            >
              <input
                id="newPassword"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                required
              />
            </Field>
            <Field label="New password again" htmlFor="confirmPassword">
              <input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
              />
            </Field>
            <div className="row">
              <button className="button" type="submit">
                Change password
              </button>
            </div>
          </form>
          <p className="stat-caveat">
            Changing your password signs you out everywhere, including here. That is deliberate — if
            someone else had your old password, this is what removes them.
          </p>
        </Card>

        <Card title="Where you are signed in">
          {devices.state !== 'ok' ? (
            <p className="muted small">We could not load your sign-ins just now.</p>
          ) : sessions.length === 0 ? (
            <p className="muted small">No other active sign-ins.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Active sign-ins</caption>
                <thead>
                  <tr>
                    <th scope="col">Session</th>
                    <th scope="col">Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => (
                    <tr key={session.id}>
                      <th scope="row">
                        {session.current ? (
                          <Pill tone="active">This device</Pill>
                        ) : (
                          'Another device'
                        )}
                      </th>
                      <td>{longDate(session.expiresAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <InfoBanner>
            We do not record where you signed in from or on what — no device names, no locations, no
            addresses. It would make this table prettier and it is not information we need.
          </InfoBanner>

          <form action={endAllSessions}>
            <button className="button button-secondary" type="submit">
              Sign out everywhere
            </button>
          </form>
        </Card>

        <Card title="Your data">
          <p className="small">
            What we store about your family, how long we keep it, and how to have it deleted are all
            on the <Link href="/privacy">Privacy</Link> page.
          </p>
        </Card>
      </div>
    </>
  );
}
