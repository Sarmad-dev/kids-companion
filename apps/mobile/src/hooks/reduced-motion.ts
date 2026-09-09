import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Whether the device asks for reduced motion.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A CHILD'S APP NEEDS THIS MORE THAN MOST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This screen has two continuous loops: a 168pt button that pulses while
 * listening, and a character that bobs the entire time it is visible. Constant
 * motion is a problem for vestibular sensitivity, and it is a problem for
 * autistic children — who are a real part of the audience for a patient,
 * repetitive conversation partner, not an edge case to be handled later.
 *
 * Both platforms expose the setting and expect an app to honour it. The web
 * dashboard already does, through `prefers-reduced-motion` in globals.css; this
 * is the same promise kept on the client where it matters more.
 *
 * NOTHING IS LOST BY TURNING THE MOTION OFF. Every state the animation
 * reinforces is carried somewhere else: the talk button changes colour, emoji
 * and label; the character's speaking state is in its accessibility label and,
 * more to the point, in the audio that is actually playing. The motion is
 * decoration on top of signals that already exist.
 *
 * Defaults to `false` — motion on — because the first render happens before the
 * asynchronous read resolves, and briefly animating for someone who asked for
 * stillness is a smaller wrong than permanently freezing the interface for
 * everyone if the query fails.
 */
export const useReducedMotion = (): boolean => {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let active = true;

    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (active) setReduced(value);
      })
      .catch(() => {
        // A platform that cannot answer is not a reason to fail; it is a reason
        // to behave as before.
      });

    // The setting can change while the app is open — someone turning it on is
    // usually someone who has just been made uncomfortable.
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
      if (active) setReduced(value);
    });

    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return reduced;
};
