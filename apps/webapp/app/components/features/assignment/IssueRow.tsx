import { EmojiScale, IconCheck, type EmojiGrade } from '@classmoji/ui-components';
import type { IssueRowData } from './assignmentTypes';

interface IssueRowProps {
  issue: IssueRowData;
  picked?: EmojiGrade;
  onPick?: (grade: EmojiGrade) => void;
  allowPick?: boolean;
  emojiGrades: EmojiGrade[];
}

/**
 * Ported from redesign (assignments.jsx:153-190).
 * Renders an issue row with optional EmojiScale when `allowPick` is true.
 */
export function IssueRow({ issue, picked, onPick, allowPick, emojiGrades }: IssueRowProps) {
  return (
    <div
      style={{
        padding: 14,
        border: '1px solid var(--line)',
        borderRadius: 12,
        background: 'white',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: '50%',
            border: '2px solid oklch(70% 0.15 155)',
            background: issue.status === 'closed' ? 'oklch(70% 0.15 155)' : 'transparent',
            display: 'grid',
            placeItems: 'center',
            color: 'white',
            flexShrink: 0,
          }}
        >
          {issue.status === 'closed' && <IconCheck size={10} />}
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 500, flex: 1 }}>
          #{issue.id} · {issue.label}
        </span>
        {picked && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 8px 3px 4px',
              borderRadius: 99,
              background: 'var(--violet-soft)',
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--violet-ink)',
            }}
          >
            <span style={{ fontSize: 14 }}>{picked.emoji}</span>
            <span className="mono">{picked.pct}</span>
          </span>
        )}
      </div>
      {allowPick && onPick && (
        <div style={{ marginTop: 10 }}>
          <EmojiScale grades={emojiGrades} picked={picked ?? null} onPick={onPick} />
        </div>
      )}
    </div>
  );
}
