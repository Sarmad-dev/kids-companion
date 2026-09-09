import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

import { mergeDescribedBy } from '../lib/aria';
import { metric, type MetricKey } from '../lib/metrics';

/**
 * The dashboard component library.
 *
 * Two things run through it.
 *
 * **Every page has four states.** Loading, empty, error, and success are all
 * first-class here rather than an afterthought, because the three that are not
 * "success" are the ones a parent hits on their first visit — a new account has
 * no data, and a phone at the school gate has no signal.
 *
 * **A metric cannot render without its explanation.** `MetricCard` takes a
 * `MetricKey`, not a label, so the explanation and the caveat come along
 * automatically. A number about a child gets interpreted whether or not anyone
 * intended it to be.
 */

/* -------------------------------------------------------------------------- */
/* Structure                                                                   */
/* -------------------------------------------------------------------------- */

export const PageHeader = ({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) => (
  <header className="page-header">
    <div>
      <h1>{title}</h1>
      {description !== undefined && (
        <p className="muted small" style={{ marginTop: 4, maxWidth: '62ch' }}>
          {description}
        </p>
      )}
    </div>
    {actions !== undefined && <div className="row">{actions}</div>}
  </header>
);

export const Card = ({
  title,
  action,
  children,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) => (
  <section className="card">
    {(title !== undefined || action !== undefined) && (
      <div className="card-header">
        {title !== undefined && <h2>{title}</h2>}
        {action}
      </div>
    )}
    {children}
  </section>
);

/* -------------------------------------------------------------------------- */
/* Metrics                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A single figure, with what it is and what it is not.
 *
 * The explanation is rendered as visible text rather than hidden behind a
 * tooltip. A tooltip is invisible on a touchscreen, invisible when printed, and
 * invisible to anyone who does not know to hover — and this is exactly the text
 * a parent needs before they draw a conclusion.
 */
export const MetricCard = ({
  metricKey,
  value,
  sub,
}: {
  metricKey: MetricKey;
  value: string;
  sub?: string;
}) => {
  const definition = metric(metricKey);
  return (
    <section className="card">
      <p className="stat-label">{definition.label}</p>
      <p className="stat-value">{value}</p>
      {sub !== undefined && <p className="small muted">{sub}</p>}
      <p className="stat-explain">{definition.explanation}</p>
      <p className="stat-caveat">{definition.notMeasuring}</p>
    </section>
  );
};

/* -------------------------------------------------------------------------- */
/* The four states                                                             */
/* -------------------------------------------------------------------------- */

/** Loading. Shaped like the content so the page does not jump when it arrives. */
export const LoadingCards = ({ count = 4 }: { count?: number }) => (
  <div className="grid" aria-busy="true" aria-live="polite">
    <span className="sr-only">Loading…</span>
    {Array.from({ length: count }, (_, i) => (
      <div key={i} className="card">
        <div className="skeleton" style={{ height: 14, width: '45%' }} />
        <div className="skeleton" style={{ height: 34, width: '65%', margin: '12px 0' }} />
        <div className="skeleton" style={{ height: 12, width: '100%' }} />
      </div>
    ))}
  </div>
);

export const LoadingBlock = ({ height = 220 }: { height?: number }) => (
  <div className="card" aria-busy="true" aria-live="polite">
    <span className="sr-only">Loading…</span>
    <div className="skeleton" style={{ height }} />
  </div>
);

/**
 * Empty.
 *
 * Always says WHY it is empty and what would fill it. "No data" tells a parent
 * nothing and reads like a fault; "nothing yet — this fills in after your child's
 * first chat" tells them the product is working and what happens next.
 */
export const EmptyState = ({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) => (
  <div className="card">
    <div className="state">
      <h2>{title}</h2>
      <p style={{ maxWidth: '48ch' }}>{description}</p>
      {action}
    </div>
  </div>
);

/**
 * Error.
 *
 * A plain sentence and, when retrying could help, a way to do it. Never a status
 * code, never a stack, never an internal hostname.
 */
export const ErrorState = ({ message, retry }: { message: string; retry?: ReactNode }) => (
  <div className="card">
    <div className="state" role="alert">
      <h2>That didn’t work</h2>
      <p style={{ maxWidth: '48ch' }}>{message}</p>
      {retry}
    </div>
  </div>
);

/**
 * Success.
 *
 * `role="status"` so a screen reader announces it without stealing focus —
 * a saved setting is worth hearing about, not worth being interrupted for.
 */
export const SuccessBanner = ({ children }: { children: ReactNode }) => (
  <p className="banner banner-success" role="status">
    <strong>Saved.</strong> {children}
  </p>
);

export const InfoBanner = ({ children }: { children: ReactNode }) => (
  <p className="banner banner-info">{children}</p>
);

export const WarningBanner = ({ children }: { children: ReactNode }) => (
  <p className="banner banner-warning">
    <strong>Note.</strong> {children}
  </p>
);

export const ErrorBanner = ({ children }: { children: ReactNode }) => (
  <p className="banner banner-error" role="alert">
    <strong>Problem.</strong> {children}
  </p>
);

/* -------------------------------------------------------------------------- */
/* Bits                                                                        */
/* -------------------------------------------------------------------------- */

/** A status pill. Carries a WORD as well as a colour — colour alone is not a signal. */
export const Pill = ({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'active' | 'flagged';
}) => (
  <span
    className={`pill${tone === 'active' ? ' pill-active' : tone === 'flagged' ? ' pill-flagged' : ''}`}
  >
    {children}
  </span>
);

/**
 * A labelled control, with its hint actually attached to it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS CLONES ITS CHILD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The hint is rendered with an id and the control is passed in as `children`,
 * so associating the two used to be the caller's job — and across nineteen
 * usages the caller did it zero times. A screen reader announced
 * "Minutes a day, number" and never "0 means no daily limit", which is the half
 * that tells you what to type.
 *
 * Leaving it to nineteen call sites would fix it today and rot by the twentieth.
 * Cloning is the version that cannot be forgotten: any control passed here is
 * described by its hint whether or not anyone remembered.
 *
 * An `aria-describedby` the caller set deliberately is merged, not replaced —
 * a field can legitimately point at both a hint and a validation message.
 */
export const Field = ({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor: string;
  children: ReactNode;
}) => {
  const hintId = `${htmlFor}-hint`;

  /* Computed before the clone so it can be narrowed to a string.
   *
   * `exactOptionalPropertyTypes` is on, so passing `string | undefined` for an
   * optional prop is an error rather than a no-op — the compiler is right to
   * insist, because `aria-describedby=""` is a dangling reference and an
   * explicit `undefined` is not the same as an absent attribute. */
  const control = isValidElement(children)
    ? (children as ReactElement<{ 'aria-describedby'?: string }>)
    : undefined;

  const describedBy =
    hint === undefined || control === undefined
      ? undefined
      : mergeDescribedBy(control.props['aria-describedby'], hintId);

  const described =
    control !== undefined && describedBy !== undefined
      ? cloneElement(control, { 'aria-describedby': describedBy })
      : children;

  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {hint !== undefined && (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      )}
      {described}
    </div>
  );
};

export const CheckboxRow = ({
  id,
  name,
  label,
  hint,
  defaultChecked,
}: {
  id: string;
  name: string;
  label: string;
  hint: string;
  defaultChecked: boolean;
}) => (
  <div className="checkbox-row">
    <input
      type="checkbox"
      id={id}
      name={name}
      defaultChecked={defaultChecked}
      aria-describedby={`${id}-hint`}
    />
    <div>
      <label htmlFor={id} style={{ fontWeight: 600 }}>
        {label}
      </label>
      <p className="hint" id={`${id}-hint`}>
        {hint}
      </p>
    </div>
  </div>
);
