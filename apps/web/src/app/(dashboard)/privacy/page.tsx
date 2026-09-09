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
  WarningBanner,
} from '../../../components/ui';
import { getChildren, requestAccountDeletion } from '../../../lib/api';
import { text } from '../../../lib/forms';
import { SESSION_COOKIE_NAME } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * Privacy.
 *
 * Written to be read by a parent, not by a lawyer. Every claim on this page is
 * one the code actually keeps, and where a thing is configurable it says so
 * rather than promising a fixed number the deployment might not be running.
 *
 * WHAT THIS PAGE DOES NOT CLAIM. It does not say the product is compliant with
 * any particular regulation, and it does not say the system is completely safe.
 * Those are assessments someone has to make about a deployment; a page cannot
 * make them true by asserting them.
 */

const ERRORS: Record<string, string> = {
  confirm: 'Type DELETE in the box to confirm.',
  password: 'That password was not right. Nothing has been deleted.',
};

export default async function PrivacyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const children = await getChildren();

  if (children.state === 'unauthorised') {
    return (
      <>
        <PageHeader title="Privacy" />
        <ErrorState message="Your session has expired. Please sign in again." />
      </>
    );
  }

  const failure = typeof params.error === 'string' ? ERRORS[params.error] : undefined;
  const items = children.state === 'ok' ? children.data.items : [];

  const deleteAccount = async (formData: FormData): Promise<void> => {
    'use server';

    if (text(formData, 'confirm').trim().toUpperCase() !== 'DELETE') {
      redirect('/privacy?error=confirm');
    }

    // Re-authentication, on the API, with the parent's own password. An active
    // session is not enough to start something irreversible.
    const result = await requestAccountDeletion(text(formData, 'confirmPassword'));
    if (result.state !== 'ok') redirect('/privacy?error=password');

    const store = await cookies();
    store.delete(SESSION_COOKIE_NAME);
    redirect('/login?deleted=1');
  };

  return (
    <>
      <PageHeader
        title="Privacy"
        description="What we hold about your family, how long we hold it, and how to get rid of it."
      />

      {failure !== undefined && <ErrorBanner>{failure}</ErrorBanner>}

      <div className="stack">
        <Card title="What we store about your child">
          <ul style={{ margin: 0, paddingLeft: 18 }} className="small">
            <li>
              <strong>A display name and a birth month.</strong> The birth month sets which
              character and which content your child is offered. We do not ask for a full date of
              birth, a surname, a school, an address, or a photograph — there is no field for any of
              them.
            </li>
            <li>
              <strong>Conversations,</strong> for as long as you choose on the{' '}
              <Link href="/controls">Parental controls</Link> page. Set it to 0 and each chat is
              deleted when it ends.
            </li>
            <li>
              <strong>Counts of activity</strong> — minutes, messages, words from our curated list,
              practice attempts. These are numbers, not content.
            </li>
            <li>
              <strong>That a safety moment happened,</strong> and roughly what kind of topic it was.
              Never what was said. We do not keep a copy of unsafe content in order to show it to
              you later.
            </li>
          </ul>
        </Card>

        <Card title="Voice recordings">
          <InfoBanner>
            By default, a recording is turned into text and then deleted — it is not kept once it
            has been transcribed.
          </InfoBanner>
          <p className="small">
            How long audio may be kept is a setting, not a fixed property of the product, and it is
            set to zero unless someone has deliberately changed it and recorded why. Where a
            recording is kept at all, it is stored encrypted, is never public, and is reachable only
            through a short-lived link this app requests on your behalf — your child’s device never
            holds a key to our storage.
          </p>
        </Card>

        <Card title="What we send to our AI provider">
          <p className="small">
            To answer your child, we send the current conversation and a small amount of context
            about how the character should behave. We do not send your child’s name, their birth
            month, your email address, your account identifier, or any of our internal identifiers.
            A check runs on every request and refuses to send anything that contains them.
          </p>
          <p className="stat-caveat">
            The provider processes the message to produce a reply. We ask providers not to use our
            traffic to train their models, and we choose providers on that basis, but their handling
            of data is theirs to describe — not something we can promise on their behalf.
          </p>
        </Card>

        <Card title="What we do not do">
          <ul style={{ margin: 0, paddingLeft: 18 }} className="small">
            <li>No advertising, and no advertising identifiers.</li>
            <li>No selling or sharing of your family’s data.</li>
            <li>No profiling of your child for anything other than making the app work.</li>
            <li>No login for children. Children are profiles you own, not accounts.</li>
          </ul>
        </Card>

        <Card title="What we cannot promise">
          <p className="small">
            Our safety system checks every message your child sends and every reply before it is
            shown, and it stops on failure rather than guessing. It is not perfect, and we will not
            tell you it is. Language moves, children are inventive, and no filter catches
            everything. Treat it as a good seatbelt, not as a reason to stop paying attention.
          </p>
          <p className="stat-caveat">
            If something reaches your child that should not have, tell us — that report is how these
            systems actually improve.
          </p>
        </Card>

        <Card title="Getting your data deleted">
          <p className="small">
            Deleting a child’s profile in the app removes that child’s conversations, practice
            results, and progress. Deleting your account removes everything for every child.
          </p>

          <WarningBanner>
            Deleting your account cannot be undone once the 30-day grace period ends. You will be
            signed out immediately and{' '}
            {items.length === 1
              ? 'your child’s profile'
              : `all ${String(items.length)} child profiles`}{' '}
            will stop working straight away.
          </WarningBanner>

          <form action={deleteAccount} className="stack">
            <Field
              label="Type DELETE to confirm"
              htmlFor="confirm"
              hint="This is here so nobody does this by accident."
            >
              <input id="confirm" name="confirm" type="text" autoComplete="off" required />
            </Field>

            <Field
              label="Your password"
              htmlFor="confirmPassword"
              hint="We ask again because a signed-in browser is not proof it is you."
            >
              <input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>

            <div className="row">
              <button className="button button-danger" type="submit">
                Delete my account and all data
              </button>
            </div>
          </form>

          <p className="stat-caveat">
            For 30 days after you ask, the account is unreachable but recoverable if you contact us.
            After that it is gone, including from our backups as they roll over.
          </p>
        </Card>
      </div>
    </>
  );
}
