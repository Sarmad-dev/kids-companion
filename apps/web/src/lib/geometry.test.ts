import { describe, expect, it } from 'vitest';

import { barGeometry, linePoints } from './geometry';

/**
 * Chart geometry.
 *
 * A chart on a page about a child is read as a claim, so the arithmetic behind
 * it has to be right and — more importantly — has to fail visibly rather than
 * quietly. The cases below are the ones that produce a plausible-looking wrong
 * picture: an empty series, a series of zeros, a single point, and a value that
 * should never exist.
 */

describe('barGeometry', () => {
  it('returns nothing for an empty series', () => {
    expect(barGeometry([], { width: 100, height: 50 })).toEqual([]);
  });

  it('draws the largest value at full height and the rest in proportion', () => {
    const bars = barGeometry([10, 5], { width: 100, height: 100, gap: 0 });

    expect(bars[0]?.height).toBe(100);
    expect(bars[0]?.y).toBe(0);
    expect(bars[1]?.height).toBe(50);
    expect(bars[1]?.y).toBe(50);
  });

  it('draws a day with no activity as no bar at all', () => {
    const bars = barGeometry([0, 0, 0], { width: 90, height: 40 });

    for (const bar of bars) {
      expect(bar.height).toBe(0);
      expect(bar.y).toBe(40);
    }
  });

  it('never draws outside the chart when a value is impossible', () => {
    // A negative or non-finite figure is a bug upstream. It must not become a
    // bar hanging off the top of the picture, which would read as a huge day.
    const bars = barGeometry([-5, Number.NaN, Number.POSITIVE_INFINITY, 10], {
      width: 100,
      height: 100,
    });

    expect(bars[0]?.height).toBe(0);
    expect(bars[1]?.height).toBe(0);
    expect(bars[2]?.height).toBe(0);
    expect(bars[3]?.height).toBe(100);
  });

  it('keeps every bar inside the width', () => {
    const bars = barGeometry([1, 2, 3, 4, 5, 6, 7], { width: 700, height: 100 });

    for (const bar of bars) {
      expect(bar.x).toBeGreaterThanOrEqual(0);
      expect(bar.x + bar.width).toBeLessThanOrEqual(700);
      expect(bar.width).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('linePoints', () => {
  it('returns an empty path for an empty series', () => {
    expect(linePoints([], { width: 100, height: 50 })).toBe('');
  });

  it('spans the full width across the series', () => {
    const path = linePoints([1, 2, 3], { width: 100, height: 100 });

    expect(path.split(' ')[0]).toBe('0,67');
    expect(path.split(' ').at(-1)).toBe('100,0');
  });

  it('places a single point at the start rather than dividing by zero', () => {
    expect(linePoints([7], { width: 100, height: 100 })).toBe('0,0');
  });

  it('flattens a series of zeros onto the baseline', () => {
    expect(linePoints([0, 0], { width: 100, height: 50 })).toBe('0,50 100,50');
  });
});
