import { Link } from 'react-router';
import { Chip, IconArrowR } from '@classmoji/ui-components';

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
  if (!quiz) return null;
  return (
    <div
      className="card"
      style={{
        padding: '14px 18px',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        borderColor: 'oklch(90% 0.04 155)',
        background: 'linear-gradient(180deg, oklch(99% 0.01 155), white 40%)',
      }}
    >
      <Chip variant="quiz">Quiz</Chip>
      <span style={{ fontSize: 15, fontWeight: 600 }}>{quiz.title}</span>
      <div style={{ flex: 1 }} />
      <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{quiz.dueText}</span>
      <Link to={allTasksHref} className="btn" style={{ textDecoration: 'none' }}>
        View all tasks <IconArrowR size={14} />
      </Link>
    </div>
  );
}

export default QuizBanner;
