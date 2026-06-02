import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useClickAway } from '@uidotdev/usehooks';
import { IconMoodHappy } from '@tabler/icons-react';
import { useGlobalFetcher, useUser } from '~/hooks';

import { ActionTypes } from '~/constants';
import { EASE_OUT_QUINT, POP_SPRING } from '~/utils/motion';
import useStore from '~/store';
import Emoji from '../../ui/display/Emoji';

interface Grade {
  id: string;
  emoji: string;
  grader?: { name: string | null } | null;
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

  // const validEmojis = getValidEmojis(emojis, emojiMappings);
  const emojiList = Object.keys(emojiMappings).map(key => {
    const isSelected = repositoryAssignment.grades?.some((grade: Grade) => grade.emoji === key);
    const isPopped = poppedKey === key && !reducedMotion;
    // Outer wrapper owns the celebratory bounce, inner button owns hover/tap, so
    // the gesture animations don't suppress the keyframe bounce on the same element.
    return (
      <motion.span
        key={key}
        className="inline-flex"
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
        onClick={() => setShow(true)}
        className="flex items-center gap-1 text-gray-600 hover:text-gray-800 cursor-pointer"
      >
        <IconMoodHappy size={16} />
        <span>Grade</span>
      </div>
      <AnimatePresence>
        {show && (
          <motion.div
            initial={reducedMotion ? { opacity: 0, y: -65 } : { opacity: 0, scale: 0.85, y: -55 }}
            animate={reducedMotion ? { opacity: 1, y: -65 } : { opacity: 1, scale: 1, y: -65 }}
            exit={reducedMotion ? { opacity: 0, y: -65 } : { opacity: 0, scale: 0.9, y: -55 }}
            transition={
              reducedMotion ? { duration: 0.12 } : { ...POP_SPRING, opacity: { duration: 0.15 } }
            }
            style={{ transformOrigin: 'top right' }}
            className="absolute py-3 px-4 border border-stone-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 rounded-md shadow-sm top-0 right-0 z-10"
          >
            <div className="flex gap-2 z-10">{emojiList}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default EmojiGrader;
