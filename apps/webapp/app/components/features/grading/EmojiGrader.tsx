import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Popover } from 'antd';
import { isScoreScheme, parseScoreEmoji, scoreEmojiId } from '@classmoji/utils';
import { useGlobalFetcher, useUser } from '~/hooks';

import { ActionTypes } from '~/constants';
import { EASE_OUT_QUINT, POP_SPRING } from '~/utils/motion';
import useStore from '~/store';
import Emoji from '../../ui/display/Emoji';

interface Grade {
  id: string;
  emoji: string;
  grader_id?: string | null;
  grader?: { id?: string; name: string | null } | null;
  created_at?: string | Date;
  token_transaction?: {
    amount: number;
  } | null;
}

interface RepositoryAssignment {
  id: string;
  assignment_id?: string;
  studentId?: string;
  teamId?: string;
  grades?: Grade[];
  repository?: { name?: string | null } | null;
}

interface EmojiGraderProps {
  repositoryAssignment: RepositoryAssignment;
  emojiMappings: Record<string, unknown>;
}

/**
 * "0–100 in steps of 5" when the scale is evenly spaced, else the values
 * themselves, for the hint under the score field.
 */
const describeScale = (values: number[]): string => {
  if (values.length < 2) return values.join(', ');
  const step = values[1] - values[0];
  const even = values.every((v, i) => i === 0 || v - values[i - 1] === step);
  return even ? `${values[0]}–${values[values.length - 1]} in steps of ${step}` : values.join(', ');
};

const EmojiGrader = ({ repositoryAssignment, emojiMappings }: EmojiGraderProps) => {
  const [show, setShow] = useState(false);
  const [poppedKey, setPoppedKey] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();
  const { fetcher, notify } = useGlobalFetcher();
  const { user } = useUser();
  const { classroom } = useStore();

  const assignGrade = (emoji: string) => {
    setPoppedKey(emoji);
    notify(ActionTypes.ADD_GRADE_TO_GIT_REPO_ASSIGNMENT, 'Assigning grade...');

    const { repository, ...assignmentWithoutCircular } = repositoryAssignment;
    const assignmentData = {
      id: assignmentWithoutCircular.id,
      assignment_id: assignmentWithoutCircular.assignment_id ?? null,
      studentId: assignmentWithoutCircular.studentId ?? null,
      teamId: assignmentWithoutCircular.teamId ?? null,
    };

    fetcher!.submit(
      {
        repoName: repository?.name ?? null,
        gitRepoAssignment: assignmentData,
        graderId: user!.id,
        grade: emoji,
        studentId: repositoryAssignment.studentId ?? null,
        teamId: repositoryAssignment.teamId ?? null,
      },
      {
        method: 'post',
        action: `/api/gitRepoAssignment/${classroom?.slug}?action=addGrade`,
        encType: 'application/json',
      }
    );
  };

  const removeGrade = (emoji: string) => {
    notify(ActionTypes.REMOVE_GRADE_FROM_GIT_REPO_ASSIGNMENT, 'Removing grade...');

    const { repository, ...assignmentWithoutCircular } = repositoryAssignment;
    const assignmentData = {
      id: assignmentWithoutCircular.id,
      assignment_id: assignmentWithoutCircular.assignment_id ?? null,
      studentId: assignmentWithoutCircular.studentId ?? null,
      teamId: assignmentWithoutCircular.teamId ?? null,
    };
    const gradeToRemove = repositoryAssignment.grades?.find(
      (grade: Grade) => grade.emoji === emoji
    );

    fetcher!.submit(
      {
        repoName: repository?.name ?? null,
        gitRepoAssignment: assignmentData,
        grade: gradeToRemove
          ? {
              id: gradeToRemove.id,
              emoji: gradeToRemove.emoji,
              token_transaction: gradeToRemove.token_transaction ?? null,
            }
          : null,
      },
      {
        method: 'post',
        action: `/api/gitRepoAssignment/${classroom?.slug}?action=removeGrade`,
        encType: 'application/json',
      }
    );
  };

  // ---- Numeric scale: one number per grader, typed in place ----
  const scaleKeys = Object.keys(emojiMappings);
  const scoreScale = isScoreScheme(scaleKeys);
  const scaleValues = scaleKeys
    .map(parseScoreEmoji)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  // The signed-in grader's own score on this row, if any. Other graders'
  // scores show in the badge list beside this control and are not editable here.
  // Rows graded before "one score per grader" may hold several; the newest
  // is the one the field edits, and a new score replaces all of them.
  const myScoreGrade = (repositoryAssignment.grades ?? [])
    .filter(g => (g.grader_id ?? g.grader?.id) === user?.id && parseScoreEmoji(g.emoji) !== null)
    .sort(
      (a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime()
    )[0];
  const myScore = myScoreGrade ? parseScoreEmoji(myScoreGrade.emoji) : null;
  const [draft, setDraft] = useState(myScore === null ? '' : String(myScore));
  const [scoreError, setScoreError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(myScore === null ? '' : String(myScore));
    setScoreError(null);
  }, [myScore]);

  const commitScore = () => {
    const text = draft.trim();
    if (text === '') {
      if (myScoreGrade) removeGrade(myScoreGrade.emoji);
      return;
    }
    const value = Number(text);
    const key = Number.isInteger(value) ? scoreEmojiId(value) : null;
    if (!key || !(key in emojiMappings)) {
      setScoreError(`Use ${describeScale(scaleValues)}`);
      return;
    }
    setScoreError(null);
    if (myScoreGrade?.emoji === key) return;
    assignGrade(key);
  };

  if (scoreScale) {
    const inputId = `score-${repositoryAssignment.id}`;
    return (
      <div className="flex flex-col gap-0.5">
        <label htmlFor={inputId} className="sr-only">
          Score out of {scaleValues[scaleValues.length - 1] ?? 100}
        </label>
        <input
          id={inputId}
          data-testid="score-grade-input"
          type="number"
          inputMode="numeric"
          min={scaleValues[0] ?? 0}
          max={scaleValues[scaleValues.length - 1] ?? 100}
          step={scaleValues.length > 1 ? scaleValues[1] - scaleValues[0] : 1}
          placeholder="0–100"
          value={draft}
          aria-invalid={scoreError ? true : undefined}
          onChange={e => {
            setDraft(e.target.value);
            if (scoreError) setScoreError(null);
          }}
          onBlur={commitScore}
          onKeyDown={e => {
            // Enter hands off to blur so the score is committed exactly once.
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === 'Escape') {
              setDraft(myScore === null ? '' : String(myScore));
              setScoreError(null);
              (e.target as HTMLInputElement).blur();
            }
          }}
          className={`w-16 h-8 rounded-md border px-2 text-sm font-semibold tabular-nums bg-white dark:bg-neutral-900 text-ink-1 focus:outline-none focus:ring-2 focus:ring-sky-300 dark:focus:ring-sky-700 ${
            scoreError
              ? 'border-rose-400 dark:border-rose-600'
              : 'border-stone-300 dark:border-neutral-600'
          }`}
        />
        {scoreError && (
          <span role="alert" className="text-xs text-rose-600 dark:text-rose-400 whitespace-nowrap">
            {scoreError}
          </span>
        )}
      </div>
    );
  }

  // ---- Glyph scale: the picker, emojis stack ----
  const emojiList = scaleKeys.map(key => {
    const isSelected = repositoryAssignment.grades?.some((grade: Grade) => grade.emoji === key);
    const isPopped = poppedKey === key && !reducedMotion;
    // Outer wrapper owns the celebratory bounce, inner button owns hover/tap, so
    // the gesture animations don't suppress the keyframe bounce on the same element.
    return (
      <motion.span
        key={key}
        data-testid={`emoji-grade-option-${key}`}
        data-selected={isSelected ? 'true' : 'false'}
        aria-pressed={isSelected}
        className="inline-flex shrink-0"
        animate={isPopped ? { scale: [1, 1.35, 0.92, 1] } : { scale: 1 }}
        transition={isPopped ? { duration: 0.4, ease: EASE_OUT_QUINT } : { duration: 0 }}
        onAnimationComplete={() => {
          if (poppedKey === key) setPoppedKey(null);
        }}
      >
        <motion.button
          type="button"
          className="cursor-pointer px-2 py-1 rounded-md hover:bg-slate-200 dark:hover:bg-neutral-700"
          style={{
            backgroundColor: isSelected ? '#ffebc2' : 'transparent',
          }}
          whileHover={reducedMotion ? undefined : { scale: 1.18, y: -2 }}
          whileTap={reducedMotion ? undefined : { scale: 0.85 }}
          transition={POP_SPRING}
          onClick={() => {
            if (isSelected) {
              removeGrade(key);
            } else assignGrade(key);
          }}
        >
          <Emoji emoji={key} />
        </motion.button>
      </motion.span>
    );
  });

  return (
    <Popover
      trigger="click"
      open={show}
      onOpenChange={setShow}
      placement="top"
      overlayInnerStyle={{ padding: '10px 12px' }}
      content={
        <div data-testid="emoji-grade-popover" className="flex flex-wrap gap-2 max-w-[23rem]">
          {emojiList}
        </div>
      }
    >
      <button
        type="button"
        data-testid="emoji-grade-trigger"
        className="text-sm font-medium text-ink-2 hover:text-ink-1 hover:underline underline-offset-2 cursor-pointer"
      >
        Grade
      </button>
    </Popover>
  );
};

export default EmojiGrader;
