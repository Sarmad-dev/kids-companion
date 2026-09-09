import Link from 'next/link';

import { Card, EmptyState, ErrorState, PageHeader, Pill } from '../../../components/ui';
import { getChildren } from '../../../lib/api';

export const dynamic = 'force-dynamic';

/**
 * Children.
 *
 * Deliberately thin. Profile fields are minimised by design — the product knows
 * a display name, a birth month, and a language, and there is no field here for
 * a school, an address, or a photograph because there is no column for one
 * (PRIVACY.md §3).
 */
export default async function ChildrenPage() {
  const result = await getChildren();

  if (result.state === 'error') {
    return (
      <>
        <PageHeader title="Children" />
        <ErrorState message={result.message} />
      </>
    );
  }
  if (result.state === 'unauthorised') {
    return (
      <>
        <PageHeader title="Children" />
        <ErrorState message="Your session has expired. Please sign in again." />
      </>
    );
  }

  const items = result.state === 'ok' ? result.data.items : [];

  return (
    <>
      <PageHeader
        title="Children"
        description="One profile per child, so a four-year-old and a nine-year-old can have different limits."
      />

      {items.length === 0 ? (
        <EmptyState
          title="No profiles yet"
          description="Add a child in the mobile app to get started. Their activity will appear here afterwards."
        />
      ) : (
        <div className="grid">
          {items.map((child) => (
            <Card key={child.id} title={child.displayName}>
              <div className="row">
                {child.ageGroup !== undefined && <Pill>{child.ageGroup.replace(/_/g, ' ')}</Pill>}
              </div>
              <p className="stat-explain">
                We store a display name, a birth month, and a language for each child, and nothing
                else. There is no field for a school, an address, or a photograph.
              </p>
              <div className="row" style={{ marginTop: 'var(--space-3)' }}>
                <Link className="button button-secondary" href={`/dashboard?childId=${child.id}`}>
                  View activity
                </Link>
                <Link className="button button-secondary" href={`/controls?childId=${child.id}`}>
                  Settings
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
