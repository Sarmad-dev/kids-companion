/**
 * The metric registry.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY METRIC THIS DASHBOARD SHOWS HAS AN ENTRY HERE, AND EVERY ENTRY SAYS
 * WHAT THE NUMBER IS AND WHAT IT IS NOT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two rules, and the second is the one under commercial pressure.
 *
 * **Every metric is explained.** A number on a dashboard about a child gets
 * interpreted whether or not anyone intended it to be. `MetricCard` will not
 * render without an explanation, so a new metric cannot ship as a bare figure.
 *
 * **The list is short on purpose.** The brief says not to overwhelm parents with
 * AI-generated metrics, and the temptation runs the other way: parents are the
 * buyers, a dense dashboard looks like value, and every extra number is a chance
 * to imply something we cannot support (Q-12). So this file holds ten metrics,
 * all of them things we can actually observe, and no derived "engagement score",
 * no percentile, and no trend line dressed up as a prediction.
 *
 * The `notMeasuring` field is not decoration. It is the sentence that stops a
 * parent drawing the wrong conclusion, and it is required.
 */

export interface MetricDefinition {
  readonly key: string;
  readonly label: string;
  /** What the number is, in one plain sentence. */
  readonly explanation: string;
  /** What it is NOT. Required — see the header. */
  readonly notMeasuring: string;
}

export const METRICS = {
  conversation_minutes: {
    key: 'conversation_minutes',
    label: 'Time chatting',
    explanation:
      'How long your child spent in conversations, measured from when each chat opened to when it ended.',
    notMeasuring: 'This is time in the app, not time spent learning.',
  },
  conversation_count: {
    key: 'conversation_count',
    label: 'Chats',
    explanation: 'How many separate conversations your child started and finished.',
    notMeasuring: 'A short chat counts the same as a long one.',
  },
  words_used: {
    key: 'words_used',
    label: 'Words used',
    explanation: 'Roughly how many words your child said across their conversations.',
    notMeasuring:
      'Speech recognition misses words, especially with children, so treat this as a rough count.',
  },
  new_vocabulary: {
    key: 'new_vocabulary',
    label: 'New words',
    explanation: 'Words from our curated word list that your child used for the first time.',
    notMeasuring:
      'Only words on our list are counted. Your child almost certainly knows many more words than this.',
  },
  stories_completed: {
    key: 'stories_completed',
    label: 'Stories',
    explanation: 'Stories your child finished with their character.',
    notMeasuring: 'A story your child abandoned halfway is not counted, and that is fine.',
  },
  exercises_completed: {
    key: 'exercises_completed',
    label: 'Practice games',
    explanation: 'Speech practice games your child finished.',
    notMeasuring: 'Finishing a game says nothing about how well anything was said.',
  },
  pronunciation_average: {
    key: 'pronunciation_average',
    label: 'Practice feedback',
    explanation:
      'How often the app recognised the word your child was practising, across their attempts.',
    notMeasuring:
      'This is a game score, not a speech assessment. Speech recognition works much less well with children than with adults, so a low band often reflects the microphone or the room rather than your child.',
  },
  active_days: {
    key: 'active_days',
    label: 'Days used',
    explanation: 'Days this week on which your child did anything at all in the app.',
    notMeasuring: 'More days is not better. Some children prefer one long chat a week.',
  },
  milestones: {
    key: 'milestones',
    label: 'Milestones',
    explanation: 'Things your child has done — a first chat, ten practice games, a week in a row.',
    notMeasuring:
      'These are not stages children are expected to reach by a particular age. A child who takes a year to reach one arrives at exactly the same milestone.',
  },
  levels: {
    key: 'levels',
    label: 'Levels',
    explanation:
      'Three descriptions of how your child has used the app so far: getting started, growing, or confident. They only ever go up.',
    notMeasuring:
      'These are not grades and not a comparison with other children — we have no information about other children.',
  },
} as const satisfies Record<string, MetricDefinition>;

export type MetricKey = keyof typeof METRICS;

export const metric = (key: MetricKey): MetricDefinition => METRICS[key];

/** Every metric, for the "what these numbers mean" page. */
export const allMetrics = (): readonly MetricDefinition[] => Object.values(METRICS);
