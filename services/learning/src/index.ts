/**
 * `@kids/learning` — the adaptive learning subsystem.
 *
 * ONE APPEND-ONLY EVENT LOG, AND EVERYTHING ELSE DERIVED FROM IT. Adding a
 * learning activity is a row in `learning_event_types`, not a release.
 *
 * TWO THINGS THIS SUBSYSTEM WILL NOT DO. It makes no medical or clinical claim
 * from any of this data, and it does not compare a child to anyone — it has
 * never seen another child's data and has no normative sample. What the product
 * specification calls "red flags" are implemented as EDUCATIONAL CONSISTENCY
 * INDICATORS, which describe app usage; see `indicators.ts` for why the rename
 * is the point rather than a preference about words.
 */

export {
  assertPayloadIsMetadata,
  CORE_EVENT_TYPES,
  dayOf,
  InvalidLearningEventError,
  weekStartOf,
  type CoreEventType,
  type LearningEvent,
  type LearningEventType,
} from './events.js';

export {
  calculateDailyProgress,
  calculateWeeklyProgress,
  groupIntoDays,
  weekStartFor,
  type DailyProgress,
  type WeeklyProgress,
} from './aggregation.js';

export {
  activeWeeks,
  calculateMilestones,
  calculateSkillLevels,
  highestOf,
  longestActiveStreak,
  pronunciationLevel,
  SKILL_LEVELS,
  type Milestone,
  type MilestoneInput,
  type SkillLevel,
  type SkillLevelInput,
  type SkillLevels,
} from './levels.js';

export {
  calculateConsistencyIndicators,
  FORBIDDEN_VOCABULARY,
  INDICATORS_PREAMBLE,
  type ConsistencyIndicator,
  type IndicatorInput,
  type IndicatorKey,
} from './indicators.js';

export {
  recordLearningEvent,
  recordLearningEvents,
  type LearningStore,
  type RecordOptions,
  type RecordResult,
} from './record.js';
