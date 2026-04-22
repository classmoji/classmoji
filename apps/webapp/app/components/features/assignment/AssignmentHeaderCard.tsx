import type { ReactNode } from 'react';
import {
  Chip,
  Button,
  IconGithub,
  IconTerminal,
  IconClock,
  type ChipVariant,
} from '@classmoji/ui-components';
import type { AssignmentHeaderData, AssignmentKind } from './assignmentTypes';

const KIND_TO_VARIANT: Record<AssignmentKind, ChipVariant> = {
  QUIZ: 'quiz',
  ASGN: 'asgn',
  PROJ: 'mod',
};

interface AssignmentHeaderCardProps {
  header: AssignmentHeaderData;
  /** Optional extra actions rendered on the right of the action row. */
  actions?: ReactNode;
}

/**
 * Ported from redesign (assignments.jsx:204-236).
 * Description backtick segments render as inline `code`.
 */
export function AssignmentHeaderCard({ header, actions }: AssignmentHeaderCardProps) {
  const {
    kind,
    module,
    weightNote,
    due,
    dueRelative,
    title,
    description,
    githubUrl,
    repoUrl,
    extensionCost,
  } = header;

  return (
    <div className="card" style={{ padding: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <Chip variant={KIND_TO_VARIANT[kind]}>{kind}</Chip>
        {module && <Chip variant="mod">MOD {module}</Chip>}
        {weightNote && (
          <span className="mono" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
            {weightNote}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {due && (
          <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>
            <span style={{ color: 'var(--ink-0)', fontWeight: 600 }}>Due {due}</span>
            {dueRelative ? ` · ${dueRelative}` : ''}
          </span>
        )}
      </div>
      <h1
        className="display"
        style={{ margin: 0, fontSize: 32, fontWeight: 500, letterSpacing: -0.4 }}
      >
        {title}
      </h1>
      {description && (
        <p
          style={{
            color: 'var(--ink-2)',
            fontSize: 14,
            lineHeight: 1.6,
            marginTop: 10,
            maxWidth: 680,
          }}
        >
          {renderWithInlineCode(description)}
        </p>
      )}
      {(githubUrl || repoUrl || extensionCost != null || actions) && (
        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          {githubUrl && (
            <a
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: 'none' }}
            >
              <Button variant="primary">
                <IconGithub size={14} /> Open repository
              </Button>
            </a>
          )}
          {repoUrl && (
            <Button>
              <IconTerminal size={14} />
              <span className="mono" style={{ fontSize: 12 }}>
                {repoUrl}
              </span>
            </Button>
          )}
          <div style={{ flex: 1 }} />
          {extensionCost != null && (
            <Button>
              <IconClock size={14} /> Request extension · {extensionCost} 🪙
            </Button>
          )}
          {actions}
        </div>
      )}
    </div>
  );
}

function renderWithInlineCode(text: string): ReactNode[] {
  return text.split('`').map((part, i) =>
    i % 2 === 1 ? (
      <code
        key={i}
        className="mono"
        style={{
          background: 'var(--bg-3)',
          padding: '1px 6px',
          borderRadius: 4,
          fontSize: 12.5,
          color: 'var(--ink-1)',
        }}
      >
        {part}
      </code>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}
