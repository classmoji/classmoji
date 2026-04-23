import { useState, type ReactNode } from 'react';
import { Button, type EmojiGrade } from '@classmoji/ui-components';
import { AssignmentHeaderCard } from './AssignmentHeaderCard';
import { IssueRow } from './IssueRow';
import { TeamCard } from './TeamCard';
import { ActivityCard } from './ActivityCard';
import { LateNoteCard } from './LateNoteCard';
import {
  DEFAULT_EMOJI_GRADES,
  type AssignmentHeaderData,
  type ChecklistData,
  type TeamData,
  type ActivityData,
  type ViewRole,
} from './assignmentTypes';

export interface AssignmentScreenProps {
  header: AssignmentHeaderData;
  checklist: ChecklistData;
  team?: TeamData | null;
  activity?: ActivityData | null;
  lateNote?: string | null;
  viewRole: ViewRole;
  /** Optional content rendered above the sidebar (e.g., stats/attempts table). */
  extraSidebar?: ReactNode;
  /** Optional content rendered below the 2-col grid (e.g., existing legacy sections). */
  footer?: ReactNode;
  /** Extra actions for the header card. */
  headerActions?: ReactNode;
}

/**
 * Assignment/quiz detail screen. Admin mode enables per-issue EmojiScale + Release grade.
 * Student mode shows a read-only checklist.
 *
 * Ported from redesign bundle (assignments.jsx:192-311).
 */
export function AssignmentScreen({
  header,
  checklist,
  team,
  activity,
  lateNote,
  viewRole,
  extraSidebar,
  footer,
  headerActions,
}: AssignmentScreenProps) {
  const isAdmin = viewRole === 'admin';

  // Uncontrolled grades state when the consumer doesn't pass controlled grades.
  const [localGrades, setLocalGrades] = useState<Record<string, EmojiGrade>>({});
  const grades = checklist.grades ?? localGrades;
  const emojiGrades = checklist.emojiGrades?.length ? checklist.emojiGrades : DEFAULT_EMOJI_GRADES;

  const pickedValues = Object.values(grades);
  const totalPct = pickedValues.length
    ? Math.round(pickedValues.reduce((s, g) => s + g.pct, 0) / pickedValues.length)
    : null;

  const handlePick = (issueId: string | number, grade: EmojiGrade) => {
    if (checklist.onPick) {
      checklist.onPick(issueId, grade);
    } else {
      setLocalGrades(prev => ({ ...prev, [String(issueId)]: grade }));
    }
  };

  const showSidebar = Boolean(team?.members.length || activity?.commits.length || lateNote || extraSidebar);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <AssignmentHeaderCard header={header} actions={headerActions} />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: showSidebar ? '1.4fr 1fr' : '1fr',
          gap: 16,
        }}
      >
        <div className="card" style={{ padding: 22 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <h2 className="display" style={{ margin: 0, fontSize: 20, fontWeight: 500 }}>
              {isAdmin ? 'Grade submission' : 'Checklist'}
            </h2>
            <div style={{ flex: 1 }} />
            {isAdmin && totalPct != null && (
              <span
                style={{
                  padding: '4px 10px',
                  background: 'var(--violet)',
                  color: 'white',
                  borderRadius: 99,
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                <span className="mono">{totalPct}</span> overall
              </span>
            )}
          </div>

          {checklist.items.length === 0 ? (
            <div
              style={{
                padding: '24px 0',
                color: 'var(--ink-3)',
                fontSize: 13,
                textAlign: 'center',
              }}
            >
              No checklist items for this assignment.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {checklist.items.map(is => (
                <IssueRow
                  key={is.id}
                  issue={is}
                  picked={grades[String(is.id)]}
                  onPick={g => handlePick(is.id, g)}
                  allowPick={isAdmin}
                  emojiGrades={emojiGrades}
                />
              ))}
            </div>
          )}

          {isAdmin && checklist.items.length > 0 && (
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <Button style={{ flex: 1 }} onClick={checklist.onSaveDraft} type="button">
                Save draft
              </Button>
              <Button
                variant="primary"
                style={{ flex: 1 }}
                onClick={checklist.onRelease}
                type="button"
              >
                Release grade
              </Button>
            </div>
          )}
        </div>

        {showSidebar && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {team && team.members.length > 0 && <TeamCard team={team} />}
            {activity && activity.commits.length > 0 && <ActivityCard activity={activity} />}
            {lateNote && <LateNoteCard note={lateNote} />}
            {extraSidebar}
          </div>
        )}
      </div>

      {footer}
    </div>
  );
}

export default AssignmentScreen;
