import { useState } from 'react';
import { useClickAway } from '@uidotdev/usehooks';
import { IconMoodHappy } from '@tabler/icons-react';
import { useGlobalFetcher, useUser } from '~/hooks';

import { ActionTypes } from '~/constants';
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
  const { fetcher, notify } = useGlobalFetcher();
  const { user } = useUser();
  const { classroom } = useStore();

  const ref = useClickAway(() => {
    setShow(false);
  }) as React.RefObject<HTMLDivElement>;

  const assignGrade = (emoji: string) => {
    notify(ActionTypes.ADD_GRADE_TO_REPOSITORY_ASSIGNMENT, 'Assigning grade...');

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
        repositoryAssignment: assignmentData,
        graderId: user!.id,
        grade: emoji,
        studentId: repositoryAssignment.studentId ?? null,
        teamId: repositoryAssignment.teamId ?? null,
      },
      {
        method: 'post',
        action: `/api/repositoryAssignment/${classroom?.slug}?action=addGrade`,
        encType: 'application/json',
      }
    );
  };

  const removeGrade = (emoji: string) => {
    notify(ActionTypes.REMOVE_GRADE_FROM_REPOSITORY_ASSIGNMENT, 'Removing grade...');

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
        repositoryAssignment: assignmentData,
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
        action: `/api/repositoryAssignment/${classroom?.slug}?action=removeGrade`,
        encType: 'application/json',
      }
    );
  };

  // const validEmojis = getValidEmojis(emojis, emojiMappings);
  const emojiList = Object.keys(emojiMappings).map(key => {
    const isSelected = repositoryAssignment.grades?.some((grade: Grade) => grade.emoji === key);
    return (
      <button
        key={key}
        className={`cursor-pointer px-2 py-1 rounded-md hover:bg-slate-200 `}
        style={{
          backgroundColor: isSelected ? '#ffebc2' : 'transparent',
        }}
        onClick={() => {
          if (isSelected) {
            removeGrade(key);
          } else assignGrade(key);
        }}
      >
        <Emoji emoji={key} />
      </button>
    );
  });

  return (
    <div className="relative" ref={ref}>
      <>
        <IconMoodHappy size={15} onClick={() => setShow(true)} className="cursor-pointer" />
      </>
      {show && (
        <div className="absolute py-3 px-4 border bg-white rounded-md shadow-sm top-0 left-1/2 transform -translate-x-2/3 -translate-y-[65px] z-10">
          <div className="flex gap-2 z-10">{emojiList}</div>
        </div>
      )}
    </div>
  );
};

export default EmojiGrader;
