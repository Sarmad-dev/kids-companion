import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import {
  Card,
  CheckboxRow,
  EmptyState,
  ErrorBanner,
  ErrorState,
  InfoBanner,
  PageHeader,
  SuccessBanner,
} from '../../../components/ui';
import { getChildren, getDashboard, updateControls } from '../../../lib/api';
import { checked, text } from '../../../lib/forms';

export const dynamic = 'force-dynamic';

/**
 * Notifications.
 *
 * Per child, because a parent of a four-year-old and a nine-year-old wants
 * different things, and because the settings live on the same row the parental
 * gate already reads.
 *
 * The safety notification is worded carefully. "We steered away from a topic"
 * is what happened; "your child asked about something bad" is not, and a
 * notification that reads like an accusation turns a nine-year-old's ordinary
 * curiosity into a family incident.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const children = await getChildren();

  if (children.state !== 'ok') {
    return (
      <>
        <PageHeader title="Notifications" />
        <ErrorState
          message={children.state === 'error' ? children.message : 'Please sign in again.'}
        />
      </>
    );
  }

  const items = children.data.items;
  if (items.length === 0) {
    return (
      <>
        <PageHeader title="Notifications" />
        <EmptyState
          title="No children yet"
          description="Notification settings are per child, so this page fills in once you have added a profile."
        />
      </>
    );
  }

  const requested = typeof params.childId === 'string' ? params.childId : undefined;
  const child = items.find((c) => c.id === requested) ?? items[0]!;
  const dashboard = await getDashboard(child.id);

  if (dashboard.state !== 'ok') {
    return (
      <>
        <PageHeader title="Notifications" />
        <ErrorState
          message={dashboard.state === 'error' ? dashboard.message : 'Please sign in again.'}
        />
      </>
    );
  }

  const preferences = dashboard.data.controls.notifications;
  const saved = params.saved !== undefined;
  const failed = params.error !== undefined;

  const save = async (formData: FormData): Promise<void> => {
    'use server';

    const childId = text(formData, 'childId');

    const result = await updateControls(childId, {
      notifications: {
        onSafetyFlag: checked(formData, 'onSafetyFlag'),
        onDailySummary: checked(formData, 'onDailySummary'),
        onWeeklySummary: checked(formData, 'onWeeklySummary'),
        onTimeLimit: checked(formData, 'onTimeLimit'),
      },
    });

    if (result.state !== 'ok') redirect(`/notifications?childId=${childId}&error=1`);

    revalidatePath('/notifications');
    redirect(`/notifications?childId=${childId}&saved=1`);
  };

  return (
    <>
      <PageHeader
        title="Notifications"
        description="What we email you about, and when. Set separately for each child."
        actions={
          items.length > 1 ? (
            <nav aria-label="Choose a child" className="row">
              {items.map((c) => (
                <Link
                  key={c.id}
                  className={c.id === child.id ? 'button' : 'button button-secondary'}
                  href={`/notifications?childId=${c.id}`}
                >
                  {c.displayName}
                </Link>
              ))}
            </nav>
          ) : undefined
        }
      />

      {saved && <SuccessBanner>Your notification settings have been updated.</SuccessBanner>}
      {failed && <ErrorBanner>We could not save your changes. Please try again.</ErrorBanner>}

      <form action={save} className="stack">
        <input type="hidden" name="childId" value={child.id} />

        <Card title={`Emails about ${child.displayName}`}>
          <CheckboxRow
            id="onSafetyFlag"
            name="onSafetyFlag"
            label="When the app steers away from a topic"
            hint="We tell you that it happened and what kind of topic it was — never what was said, because we do not keep a copy of it. Children ask about everything, and one of these is not a cause for alarm."
            defaultChecked={preferences.onSafetyFlag}
          />
          <CheckboxRow
            id="onTimeLimit"
            name="onTimeLimit"
            label="When the daily time limit is reached"
            hint="Sent once a day at most. Your child sees a friendly message and the app stops either way."
            defaultChecked={preferences.onTimeLimit}
          />
          <CheckboxRow
            id="onDailySummary"
            name="onDailySummary"
            label="A daily summary"
            hint="The same figures as the dashboard, in an email. Most parents find the weekly one is enough."
            defaultChecked={preferences.onDailySummary}
          />
          <CheckboxRow
            id="onWeeklySummary"
            name="onWeeklySummary"
            label="A weekly summary"
            hint="Sent on Monday, covering the week before."
            defaultChecked={preferences.onWeeklySummary}
          />
        </Card>

        <InfoBanner>
          Some emails are not optional: a password change, a sign-in from a new device, and anything
          about your account being deleted. Those are security messages, and turning them off would
          only help someone who was not you.
        </InfoBanner>

        <div className="row">
          <button className="button" type="submit">
            Save notification settings
          </button>
        </div>
      </form>
    </>
  );
}
