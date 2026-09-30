/**
 * Shows the field-level problems returned by zod validation in the core.
 *
 * The goal is that a rejected save tells the user exactly which box to fix,
 * instead of a generic "something went wrong".
 */
import { useApp } from '@renderer/state/store';
import { Banner, Button } from '@renderer/components/ui';

export function FieldIssueHost(): JSX.Element | null {
  const { fieldIssues, clearFieldIssues } = useApp();
  if (!fieldIssues) return null;
  const entries = Object.entries(fieldIssues.fields);
  return (
    <div style={{ position: 'fixed', left: 24, bottom: 24, zIndex: 80, maxWidth: 460 }}>
      <Banner
        tone="danger"
        title={fieldIssues.message}
        actions={
          <Button size="sm" variant="ghost" onClick={clearFieldIssues}>
            Dismiss
          </Button>
        }
      >
        {entries.length > 0 ? (
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {entries.slice(0, 6).map(([field, message]) => (
              <li key={field} className="small">
                <strong>{field.replace(/^input\./, '').replace(/\./g, ' › ')}</strong>: {message}
              </li>
            ))}
          </ul>
        ) : null}
      </Banner>
    </div>
  );
}
