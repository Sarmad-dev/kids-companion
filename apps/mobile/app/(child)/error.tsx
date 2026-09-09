import { router, useLocalSearchParams } from 'expo-router';

import { failureFor, type FailureKind } from '../../src/api/errors';
import { FriendlyError, Screen } from '../../src/components/child/index';
import { useApp } from '../../src/state/app-context';

/**
 * A friendly failure, as a destination.
 *
 * Most failures are rendered in place by the screen that hit them. This route
 * exists for the ones that have no screen left to render into — a session that
 * ended under a child, a route reached without the state it needs — and it
 * takes a failure KIND rather than a message, so no caller can route a raw
 * error string into a child's view by accident.
 *
 * One warm sentence in the character's voice. No code, no status, no request
 * id, no provider name, and "Try again" only when a retry could plausibly help.
 */
export default function ErrorScreen() {
  const { kind } = useLocalSearchParams<{ kind?: string }>();
  const { child } = useApp();

  const failure = failureFor((kind ?? 'unknown') as FailureKind);

  return (
    <Screen testID="screen-error">
      <FriendlyError
        message={failure.message}
        slug={child.characterSlug}
        onHome={() => {
          router.replace('/(child)/home');
        }}
        {...(failure.retryable
          ? {
              onRetry: () => {
                router.replace('/(child)/home');
              },
            }
          : {})}
      />
    </Screen>
  );
}
