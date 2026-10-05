import type { Feature } from '../types/feature';

export const features: Feature[] = [
  {
    id: 'publish',
    kicker: 'Assignments',
    title: 'Publish once. Every student gets a repo.',
    description:
      'Classmoji creates a private Github or Gitlab repository for every student and marks their work submitted when they push or close an issue.',
    link: { label: 'Learn about repositories', href: '/docs/instructors/repositories' },
  },
  {
    id: 'claude',
    kicker: 'Claude integration',
    title: 'Your whole class, one message away.',
    description:
      'Ask Claude to create and publish an assignment, provision every student’s repository, and split grading across your TAs.',
    link: { label: 'Connect Claude', href: '/docs/instructors/mcp-server' },
  },
  {
    id: 'quiz',
    kicker: 'AI quizzes',
    title: 'Quizzes that check understanding, not memorization.',
    description:
      'Turn on code review and an AI tutor reads each student’s own repository, asks about their code, and gives feedback on every answer, so you see who really understands it.',
  },
  {
    id: 'grading',
    kicker: 'Grading',
    title: 'Grade with emoji.',
    description:
      'Every grade is an emoji: pick one from your scale, or a number badge from 0 to 100. Split submissions across your graders, and the counts and gradebook stay in sync as you go.',
    link: { label: 'Learn about grading', href: '/docs/instructors/grading' },
  },
];
