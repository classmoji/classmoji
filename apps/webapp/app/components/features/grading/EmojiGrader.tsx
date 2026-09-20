import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useClickAway } from '@uidotdev/usehooks';
import { IconMoodHappy } from '@tabler/icons-react';
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

  const ref = useClickAway(() => {
    setShow(false);
  }) as React.RefObject<HTMLDivElement>;

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
  const myScoreGrade = repositoryAssignment.grades?.find(
    g => (g.grader_id ?? g.grader?.id) === user?.id && parseScoreEmoji(g.emoji) !== null
  );
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
    <div className="relative" ref={ref}>
      <div
        data-testid="emoji-grade-trigger"
        onClick={() => setShow(true)}
        className="flex items-center gap-1 text-gray-600 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100 cursor-pointer"
      >
        <IconMoodHappy size={16} />
        <span>Grade</span>
      </div>
      <AnimatePresence>
        {show && (
          <motion.div
            data-testid="emoji-grade-popover"
            initial={reducedMotion ? { opacity: 0, y: -65 } : { opacity: 0, scale: 0.85, y: -55 }}
            animate={reducedMotion ? { opacity: 1, y: -65 } : { opacity: 1, scale: 1, y: -65 }}
            exit={reducedMotion ? { opacity: 0, y: -65 } : { opacity: 0, scale: 0.9, y: -55 }}
            transition={
              reducedMotion ? { duration: 0.12 } : { ...POP_SPRING, opacity: { duration: 0.15 } }
            }
            style={{ transformOrigin: 'top right' }}
            className="absolute w-max py-3 px-4 border border-stone-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 rounded-md shadow-sm top-0 right-0 z-10"
          >
            <div className="flex flex-wrap gap-2 z-10 max-w-[23rem]">{emojiList}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default EmojiGrader;
