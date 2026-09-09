import { shortDate } from '../lib/format';
import { barGeometry, linePoints, type SeriesPoint } from '../lib/geometry';

export { barGeometry, linePoints };
export type { SeriesPoint };

/**
 * Charts.
 *
 * Inline SVG rather than a charting library, for three reasons: the shapes here
 * are a bar and a line, a library is 90 kB to draw them, and a library's canvas
 * output is invisible to a screen reader unless someone remembers to describe
 * it — which nobody does.
 *
 * EVERY CHART SHIPS WITH ITS DATA IN TEXT. Each one has a visually hidden table
 * carrying the same numbers, so the chart is decoration for people who can see
 * it and the table is the actual content. That is also why the axis labels are
 * sparse: the precise values are available to everyone in the table.
 */

/** The hidden table that carries the real numbers. */
const DataTable = ({
  caption,
  points,
  unit,
}: {
  caption: string;
  points: readonly SeriesPoint[];
  unit: string;
}) => (
  <table className="sr-only">
    <caption>{caption}</caption>
    <thead>
      <tr>
        <th scope="col">Date</th>
        <th scope="col">{unit}</th>
      </tr>
    </thead>
    <tbody>
      {points.map((point) => (
        <tr key={point.label}>
          <th scope="row">{shortDate(point.label)}</th>
          <td>{point.value}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

export const BarChart = ({
  points,
  title,
  unit,
  height = 160,
}: {
  points: readonly SeriesPoint[];
  title: string;
  unit: string;
  height?: number;
}) => {
  const width = 640;
  const bars = barGeometry(
    points.map((p) => p.value),
    { width, height },
  );
  const max = Math.max(...points.map((p) => p.value), 1);

  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${String(width)} ${String(height + 22)}`}
        // `img` plus a label: the chart is one described picture, not a tree of
        // rectangles for a screen reader to walk through.
        role="img"
        aria-label={`${title}. Highest value ${String(max)} ${unit}. The same figures are in the table below.`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        preserveAspectRatio="none"
      >
        {bars.map((bar, i) => (
          <rect
            key={i}
            x={bar.x}
            y={bar.y}
            width={bar.width}
            height={bar.height}
            rx={3}
            fill="var(--accent)"
          />
        ))}
        <line
          x1={0}
          y1={height}
          x2={width}
          y2={height}
          stroke="var(--border-strong)"
          strokeWidth={1}
        />
      </svg>
      <figcaption className="row small muted" style={{ justifyContent: 'space-between' }}>
        <span>{points[0] === undefined ? '' : shortDate(points[0].label)}</span>
        <span>{`up to ${String(max)} ${unit}`}</span>
        <span>{points.at(-1) === undefined ? '' : shortDate(points.at(-1)!.label)}</span>
      </figcaption>
      <DataTable caption={title} points={points} unit={unit} />
    </figure>
  );
};

export const LineChart = ({
  points,
  title,
  unit,
  height = 160,
}: {
  points: readonly SeriesPoint[];
  title: string;
  unit: string;
  height?: number;
}) => {
  const width = 640;
  const path = linePoints(
    points.map((p) => p.value),
    { width, height },
  );
  const max = Math.max(...points.map((p) => p.value), 1);

  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${String(width)} ${String(height + 22)}`}
        role="img"
        aria-label={`${title}. Highest value ${String(max)} ${unit}. The same figures are in the table below.`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        preserveAspectRatio="none"
      >
        <polyline
          points={path}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <line
          x1={0}
          y1={height}
          x2={width}
          y2={height}
          stroke="var(--border-strong)"
          strokeWidth={1}
        />
      </svg>
      <figcaption className="row small muted" style={{ justifyContent: 'space-between' }}>
        <span>{points[0] === undefined ? '' : shortDate(points[0].label)}</span>
        <span>{`up to ${String(max)} ${unit}`}</span>
        <span>{points.at(-1) === undefined ? '' : shortDate(points.at(-1)!.label)}</span>
      </figcaption>
      <DataTable caption={title} points={points} unit={unit} />
    </figure>
  );
};

/**
 * A level, as three steps.
 *
 * Filled steps, not a percentage. "Growing" is a description; "67%" would be a
 * measurement, and this system has nothing to measure against.
 */
export const LevelMeter = ({ level, label }: { level: string; label: string }) => {
  const index = ['getting_started', 'growing', 'confident'].indexOf(level);
  const filled = index < 0 ? 0 : index + 1;

  return (
    <div>
      <p className="stat-label">{label}</p>
      <div className="row" style={{ gap: 4, margin: '6px 0' }} aria-hidden="true">
        {[0, 1, 2].map((step) => (
          <span
            key={step}
            style={{
              height: 10,
              flex: 1,
              borderRadius: 999,
              background: step < filled ? 'var(--accent)' : 'var(--surface-sunken)',
            }}
          />
        ))}
      </div>
      <p className="small" style={{ fontWeight: 600 }}>
        {['Getting started', 'Growing', 'Confident'][Math.max(0, filled - 1)]}
      </p>
    </div>
  );
};
