'use client';

/**
 * The error boundary.
 *
 * The thrown error is DELIBERATELY not rendered. A Next.js error can carry a
 * stack, an internal hostname, or a fragment of a query, and none of that helps
 * a parent. They get a sentence and a way to try again.
 */
export default function AreaError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="card">
      <div className="state" role="alert">
        <h2>That didn’t load</h2>
        <p style={{ maxWidth: '48ch' }}>
          Something went wrong at our end. Your child’s data is safe — this page just could not be
          shown.
        </p>
        <button className="button" type="button" onClick={reset}>
          Try again
        </button>
      </div>
    </div>
  );
}
