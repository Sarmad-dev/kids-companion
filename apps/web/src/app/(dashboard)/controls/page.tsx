import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import {
  Card,
  CheckboxRow,
  EmptyState,
  ErrorBanner,
  ErrorState,
  Field,
  InfoBanner,
  PageHeader,
  SuccessBanner,
} from '../../../components/ui';
import { getCharacters, getChildren, getDashboard, updateControls } from '../../../lib/api';
import { checked, optionalText, text, textList, wholeNumber } from '../../../lib/forms';

export const dynamic = 'force-dynamic';

/**
 * Parental controls.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS PAGE IS A VIEW OF A SETTING. IT IS NOT THE SETTING.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every control here is enforced in `apps/api/src/parental-gate.ts`, on the
 * server, on every path a child can reach — conversation start, every message,
 * every voice turn, every practice attempt. Nothing on this page enforces
 * anything, and nothing in the child's app does either. A child holding a
 * modified build gets exactly the same answers.
 *
 * The form posts to a Server Action rather than a client fetch, so it works with
 * JavaScript disabled and the session token stays on the server.
 */

const DAYS = [
  [1, 'Monday'],
  [2, 'Tuesday'],
  [3, 'Wednesday'],
  [4, 'Thursday'],
  [5, 'Friday'],
  [6, 'Saturday'],
  [7, 'Sunday'],
] as const;

const ERRORS: Record<string, string> = {
  days: 'Choose at least one day. To stop access completely, use the pause switch instead.',
  quiet: 'Set both a start and an end time for quiet hours, or clear them both.',
  session: 'The per-session limit cannot be longer than the daily limit.',
  save: 'We could not save your changes. Please try again.',
};

export default async function ControlsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const children = await getChildren();

  if (children.state !== 'ok') {
    return (
      <>
        <PageHeader title="Parental controls" />
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
        <PageHeader title="Parental controls" />
        <EmptyState
          title="No children yet"
          description="Settings are per child, so this page fills in once you have added a profile."
        />
      </>
    );
  }

  const requested = typeof params.childId === 'string' ? params.childId : undefined;
  const child = items.find((c) => c.id === requested) ?? items[0]!;

  const [dashboard, characters] = await Promise.all([
    getDashboard(child.id),
    getCharacters(child.id),
  ]);

  if (dashboard.state !== 'ok') {
    return (
      <>
        <PageHeader title="Parental controls" />
        <ErrorState
          message={dashboard.state === 'error' ? dashboard.message : 'Please sign in again.'}
        />
      </>
    );
  }

  const controls = dashboard.data.controls;
  const cast = characters.state === 'ok' ? characters.data.items : [];
  const saved = params.saved !== undefined;
  const failure = typeof params.error === 'string' ? ERRORS[params.error] : undefined;

  const save = async (formData: FormData): Promise<void> => {
    'use server';

    const childId = text(formData, 'childId');
    const back = (query: string) => `/controls?childId=${childId}${query}`;

    const allowedDays = textList(formData, 'allowedDays')
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 7);

    // An empty list means "no restriction" everywhere downstream, so unticking
    // every day would silently do the OPPOSITE of what the parent just did. That
    // asymmetry is worth an error rather than a clever guess.
    if (allowedDays.length === 0) redirect(back('&error=days'));

    const quietHoursStart = optionalText(formData, 'quietHoursStart');
    const quietHoursEnd = optionalText(formData, 'quietHoursEnd');
    if ((quietHoursStart === null) !== (quietHoursEnd === null)) redirect(back('&error=quiet'));

    const dailyMinuteLimit = wholeNumber(formData, 'dailyMinuteLimit', {
      fallback: 30,
      max: 240,
    });
    const sessionMinuteLimit = wholeNumber(formData, 'sessionMinuteLimit', {
      fallback: 15,
      max: 120,
    });
    if (sessionMinuteLimit > dailyMinuteLimit) redirect(back('&error=session'));

    const blockedTopics = text(formData, 'blockedTopics')
      .split(/[\n,]/)
      .map((topic) => topic.trim().toLowerCase())
      .filter((topic) => topic.length >= 2 && topic.length <= 40)
      .slice(0, 50);

    const languageLock = optionalText(formData, 'languageLock');

    const result = await updateControls(childId, {
      dailyMinuteLimit,
      sessionMinuteLimit,
      quietHoursStart,
      quietHoursEnd,
      allowedDays: allowedDays.length === 7 ? [] : allowedDays,
      allowedCharacterIds: textList(formData, 'allowedCharacterIds'),
      blockedTopics,
      languageLock,
      contentFilterLevel: text(formData, 'contentFilterLevel') === 'strict' ? 'strict' : 'standard',
      transcriptRetentionDays: wholeNumber(formData, 'transcriptRetentionDays', {
        fallback: 30,
        max: 365,
      }),
      isPaused: checked(formData, 'isPaused'),
    });

    if (result.state !== 'ok') redirect(back('&error=save'));

    revalidatePath('/controls');
    revalidatePath('/dashboard');
    redirect(back('&saved=1'));
  };

  const selectedDays =
    controls.allowedDays.length === 0 ? [1, 2, 3, 4, 5, 6, 7] : controls.allowedDays;

  return (
    <>
      <PageHeader
        title="Parental controls"
        description="These are enforced on our servers. The app on your child’s device cannot be persuaded to ignore them."
        actions={
          items.length > 1 ? (
            <nav aria-label="Choose a child" className="row">
              {items.map((c) => (
                <Link
                  key={c.id}
                  className={c.id === child.id ? 'button' : 'button button-secondary'}
                  href={`/controls?childId=${c.id}`}
                >
                  {c.displayName}
                </Link>
              ))}
            </nav>
          ) : undefined
        }
      />

      {saved && <SuccessBanner>Your settings apply from your child’s next chat.</SuccessBanner>}
      {failure !== undefined && <ErrorBanner>{failure}</ErrorBanner>}

      <form action={save} className="stack">
        <input type="hidden" name="childId" value={child.id} />

        <Card title={`Access for ${child.displayName}`}>
          <CheckboxRow
            id="isPaused"
            name="isPaused"
            label="Pause the app"
            hint="Your child sees a friendly “let’s play later” message. They are not told they were blocked, or by whom."
            defaultChecked={controls.isPaused}
          />
        </Card>

        <Card title="Time">
          <Field
            label="Minutes a day"
            htmlFor="dailyMinuteLimit"
            hint="0 means no daily limit. Counted from when each chat opens to when it ends."
          >
            <input
              id="dailyMinuteLimit"
              name="dailyMinuteLimit"
              type="number"
              min={0}
              max={240}
              defaultValue={controls.dailyMinuteLimit}
            />
          </Field>

          <Field
            label="Minutes in one sitting"
            htmlFor="sessionMinuteLimit"
            hint="Cannot be longer than the daily limit. 0 means no limit on a single chat."
          >
            <input
              id="sessionMinuteLimit"
              name="sessionMinuteLimit"
              type="number"
              min={0}
              max={120}
              defaultValue={controls.sessionMinuteLimit}
            />
          </Field>

          <fieldset>
            <legend>Quiet hours</legend>
            <p className="hint">
              The app will not start a chat between these times. Leave both empty for none. Times
              that cross midnight — 20:00 to 07:00, for example — work as you would expect.
            </p>
            <div className="row">
              <Field label="From" htmlFor="quietHoursStart">
                <input
                  id="quietHoursStart"
                  name="quietHoursStart"
                  type="time"
                  defaultValue={controls.quietHoursStart?.slice(0, 5) ?? ''}
                />
              </Field>
              <Field label="Until" htmlFor="quietHoursEnd">
                <input
                  id="quietHoursEnd"
                  name="quietHoursEnd"
                  type="time"
                  defaultValue={controls.quietHoursEnd?.slice(0, 5) ?? ''}
                />
              </Field>
            </div>
          </fieldset>

          <fieldset>
            <legend>Days</legend>
            <p className="hint">Days your child can use the app. At least one must be chosen.</p>
            {DAYS.map(([value, label]) => (
              <CheckboxRow
                key={value}
                id={`day-${String(value)}`}
                name="allowedDays"
                label={label}
                hint=""
                defaultChecked={selectedDays.includes(value)}
              />
            ))}
          </fieldset>
        </Card>

        <Card title="Content">
          <fieldset>
            <legend>Safety filter</legend>
            <p className="hint">
              Standard is already strict — the safety system runs on every message either way, and
              cannot be turned off. Strict tightens the borderline cases, and is a good fit for
              younger children.
            </p>
            <div className="checkbox-row">
              <input
                type="radio"
                id="filter-standard"
                name="contentFilterLevel"
                value="standard"
                defaultChecked={controls.contentFilterLevel === 'standard'}
              />
              <label htmlFor="filter-standard">Standard</label>
            </div>
            <div className="checkbox-row">
              <input
                type="radio"
                id="filter-strict"
                name="contentFilterLevel"
                value="strict"
                defaultChecked={controls.contentFilterLevel === 'strict'}
              />
              <label htmlFor="filter-strict">Strict</label>
            </div>
          </fieldset>

          <Field
            label="Topics to steer away from"
            htmlFor="blockedTopics"
            hint="One per line. These are added to the safety rules that always apply — they never replace them."
          >
            <textarea
              id="blockedTopics"
              name="blockedTopics"
              rows={4}
              defaultValue={controls.blockedTopics.join('\n')}
            />
          </Field>

          <Field
            label="Language"
            htmlFor="languageLock"
            hint="Locks conversations to one language. Leave as “either” to let your child switch."
          >
            <select
              id="languageLock"
              name="languageLock"
              defaultValue={controls.languageLock ?? ''}
            >
              <option value="">Either</option>
              <option value="en">English only</option>
              <option value="ur">Urdu only</option>
            </select>
          </Field>
        </Card>

        {cast.length > 0 && (
          <Card title="Characters">
            <p className="hint">
              Tick none to allow every character. Tick some to allow only those.
            </p>
            {cast.map((character) => (
              <CheckboxRow
                key={character.id}
                id={`character-${character.id}`}
                name="allowedCharacterIds"
                label={character.displayName}
                hint={character.tagline}
                defaultChecked={controls.allowedCharacterIds.includes(character.id)}
              />
            ))}
          </Card>
        )}

        <Card title="How long we keep chats">
          <InfoBanner>
            Voice recordings are handled separately and are deleted within hours by default,
            regardless of this setting. See <Link href="/privacy">Privacy</Link>.
          </InfoBanner>
          <Field
            label="Days to keep conversation transcripts"
            htmlFor="transcriptRetentionDays"
            hint="0 deletes each chat as soon as it ends. Shortening this deletes older chats at the next sweep — including ones you may still want."
          >
            <input
              id="transcriptRetentionDays"
              name="transcriptRetentionDays"
              type="number"
              min={0}
              max={365}
              defaultValue={controls.transcriptRetentionDays}
            />
          </Field>
        </Card>

        <div className="row">
          <button className="button" type="submit">
            Save settings
          </button>
        </div>
      </form>
    </>
  );
}
