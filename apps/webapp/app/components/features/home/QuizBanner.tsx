import { Link } from 'react-router';
import { IconArrowR } from '@classmoji/ui-components';

export interface QuizBannerQuiz {
  id: string;
  title: string;
  dueText: string;
  href?: string;
}

interface QuizBannerProps {
  quiz: QuizBannerQuiz | null;
  allTasksHref: string;
}

export function QuizBanner({ quiz, allTasksHref }: QuizBannerProps) {
  if (!quiz) {
    return (
      <div className="panel flex items-center gap-3 px-4 py-3">
        <span className="chip chip-quiz">QUIZ</span>
        <span className="text-[13.5px] font-medium text-ink-2">
          No upcoming quizzes
        </span>
        <div className="flex-1" />
        <Link
          to={allTasksHref}
          className="btn btn-sm btn-ghost text-ink-2 no-underline"
        >
          View all tasks <IconArrowR size={12} />
        </Link>
      </div>
    );
  }

  return (
    <div className="panel flex items-center gap-3 px-4 py-3">
      <span className="chip chip-quiz">QUIZ</span>
      <span className="text-[13.5px] font-medium">{quiz.title}</span>
      <span className="text-[12.5px] text-ink-2">{quiz.dueText}</span>
      <div className="flex-1" />
      <Link
        to={allTasksHref}
        className="btn btn-sm btn-ghost text-ink-2 no-underline"
      >
        View all tasks <IconArrowR size={12} />
      </Link>
    </div>
  );
}

export default QuizBanner;
