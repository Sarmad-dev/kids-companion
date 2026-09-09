/**
 * Chart geometry.
 *
 * Separated from the components that draw with it so it can be tested without a
 * renderer: these are two pure functions from numbers to coordinates, and a bug
 * in either one produces a chart that is quietly wrong rather than one that
 * fails to appear.
 */

export interface SeriesPoint {
  readonly label: string;
  readonly value: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Bars, in SVG coordinates (y grows downwards, so a taller bar has a smaller y).
 *
 * Every value is made drawable BEFORE the maximum is taken, so a single
 * impossible figure cannot scale the rest of the series away.
 */
/** One value, made safe to draw. A negative or non-finite figure is a bug
 * upstream; it must not become a bar hanging off the top of the chart, and it
 * must not take the rest of the series down with it. */
const drawable = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

export const barGeometry = (
  values: readonly number[],
  options: { width: number; height: number; gap?: number },
): readonly Rect[] => {
  const gap = options.gap ?? 4;
  if (values.length === 0) return [];

  const safe = values.map(drawable);
  // Floored at 1 so a series of zeros produces flat bars rather than a division
  // by zero, and taken from the SANITISED values so one bad figure cannot scale
  // the whole chart to nothing.
  const max = Math.max(...safe, 1);
  const slot = options.width / values.length;
  const barWidth = Math.max(1, slot - gap);

  return safe.map((value, i) => {
    const height = Math.round((value / max) * options.height);
    return {
      x: Math.round(i * slot + gap / 2),
      y: options.height - height,
      width: Math.round(barWidth),
      height,
    };
  });
};

/** A polyline for a line chart, in the same coordinate space. */
export const linePoints = (
  values: readonly number[],
  options: { width: number; height: number },
): string => {
  if (values.length === 0) return '';
  const safe = values.map(drawable);
  const max = Math.max(...safe, 1);
  // A single point has nowhere to travel, so it sits at x = 0 rather than
  // dividing by zero and drawing nothing.
  const step = values.length === 1 ? 0 : options.width / (values.length - 1);

  return safe
    .map((value, i) => {
      const y = options.height - (value / max) * options.height;
      return `${String(Math.round(i * step))},${String(Math.round(y))}`;
    })
    .join(' ');
};
