import React from 'react';
import type { ReactNode } from 'react';
import { PlusIcon } from 'lucide-react';

const link = 'font-medium text-accent underline decoration-accent/30 underline-offset-4 hover:decoration-accent';

// Facts only: no prices are published, so none are quoted here.
const QUESTIONS: { q: string; a: ReactNode }[] = [
  {
    q: 'Is Classmoji free?',
    a: (
      <>
        Yes. Classrooms are free, including teams, assistants, and tokens. Pro adds the AI features (AI
        quizzes and the syllabus bot) and a custom domain for your class website.
      </>
    ),
  },
  {
    q: 'Can I self-host it?',
    a: (
      <>
        Yes. Classmoji is open source under the AGPL-3.0 license, and you can run it yourself with Docker.{' '}
        <a href="/docs/self-hosting/docker" className={link}>
          Self-hosting guide
        </a>
      </>
    ),
  },
  {
    q: 'Who owns the student repositories?',
    a: (
      <>
        You do. Classmoji creates them in your class&rsquo;s own Github organization or Gitlab group, not
        in an account of ours.{' '}
        <a href="/docs/instructors/repositories" className={link}>
          Repositories
        </a>
      </>
    ),
  },
  {
    q: 'Can my TAs help grade?',
    a: (
      <>
        Yes. Add assistants to your class, assign graders to each assignment, and everyone works from their
        own grading queue.{' '}
        <a href="/docs/instructors/grading" className={link}>
          Grading
        </a>
      </>
    ),
  },
  {
    q: 'What happens with late work?',
    a: (
      <>
        The last push before the deadline is the submission. Students can spend tokens on extra hours, and
        you can override a late submission when it makes sense.{' '}
        <a href="/docs/instructors/tokens" className={link}>
          Tokens and extensions
        </a>
      </>
    ),
  },
];

export function Faq() {
  return (
    <section aria-labelledby="faq-heading" className="mx-auto mt-28 max-w-3xl lg:mt-36">
      <h2
        id="faq-heading"
        className="text-center text-[2rem] font-bold leading-[1.15] tracking-tight text-ink-0 sm:text-[2.375rem]"
      >
        Questions
      </h2>
      <div className="mt-10 border-t border-line">
        {QUESTIONS.map(({ q, a }) => (
          <details key={q} className="group border-b border-line">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-[1.0625rem] font-semibold text-ink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
              {q}
              <PlusIcon
                className="h-5 w-5 shrink-0 text-ink-3 transition-transform duration-200 group-open:rotate-45"
                aria-hidden
              />
            </summary>
            <p className="-mt-1 pb-5 pr-10 text-[1rem] leading-relaxed text-ink-2">{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
