import { useState } from 'react';
import { useClickAway } from '@uidotdev/usehooks';
import { IconMoodHappy } from '@tabler/icons-react';
import { useGlobalFetcher, useUser } from '~/hooks';

import { ActionTypes } from '~/constants';
import useStore from '~/store';
import Emoji from '../../ui/display/Emoji';

const EmojiGrader = ({ repositoryAssignment, emojiMappings }) => {
  const [show, setShow] = useState(false);
  const { fetcher, notify } = useGlobalFetcher();
  const { user } = useUser();
  const { classroom } = useStore(state => state);

  const ref = useClickAway(() => {
    setShow(false);
  });

  const assignGrade = emoji => {
    notify(ActionTypes.ADD_GRADE_TO_REPOSITORY_ASSIGNMENT, 'Assigning grade...');

    const { repository, ...assignmentWithoutCircular } = repositoryAssignment;
    const assignmentData = {
      ...assignmentWithoutCircular,
      repository: { name: repository.name },
    };

    fetcher.submit(
      {
        repoName: assignmentData.repository.name,
        repositoryAssignment: assignmentData,
        graderId: user.id,
        grade: emoji,
        studentId: repositoryAssignment.studentId,
        teamId: repositoryAssignment.teamId,
      },
      {
        method: 'post',
        action: `/api/repositoryAssignment/${classroom?.slug}?action=addGrade`,
        encType: 'application/json',
      }
    );
  };

  const removeGrade = emoji => {
    notify(ActionTypes.REMOVE_GRADE_FROM_REPOSITORY_ASSIGNMENT, 'Removing grade...');

    const { repository, ...assignmentWithoutCircular } = repositoryAssignment;
    const assignmentData = {
      ...assignmentWithoutCircular,
      repository: { name: repository.name },
    };

    fetcher.submit(
      {
        repoName: assignmentData.repository.name,
        repositoryAssignment: assignmentData,
        grade: repositoryAssignment.grades.find(grade => grade.emoji === emoji),
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
    const isSelected = repositoryAssignment.grades.some(grade => grade.emoji === key);
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
