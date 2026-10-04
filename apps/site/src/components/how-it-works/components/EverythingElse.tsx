import React from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  CoinsIcon,
  FileTextIcon,
  FlaskConicalIcon,
  GlobeIcon,
  LayersIcon,
  ListChecksIcon,
  PresentationIcon,
  UsersIcon,
} from 'lucide-react';

type Item = { icon: LucideIcon; title: string; description: string; href?: string };

// The features that don't need a full demo. Each links to its docs page when one exists.
const ITEMS: Item[] = [
  {
    icon: LayersIcon,
    title: 'Modules',
    description: 'Group repos, pages, quizzes, and slides into an ordered path for students.',
    href: '/docs/instructors/modules',
  },
  {
    icon: FileTextIcon,
    title: 'Pages',
    description: 'Write syllabi, guides, and notes as course pages your students read in the class.',
    href: '/docs/instructors/pages',
  },
  {
    icon: FlaskConicalIcon,
    title: 'Autograding',
    description: 'Run your tests on Github Actions or Gitlab CI and see results on each submission.',
    href: '/docs/instructors/autograding',
  },
  {
    icon: CoinsIcon,
    title: 'Tokens and extensions',
    description: 'Students spend tokens on extra time instead of emailing you for it.',
    href: '/docs/instructors/tokens',
  },
  {
    icon: UsersIcon,
    title: 'Teaching staff roles',
    description: 'Owners, teachers, and assistants each get the view their job needs.',
    href: '/docs/instructors/roster',
  },
  {
    icon: GlobeIcon,
    title: 'Class websites',
    description: 'Publish a public site for your course, on your own domain with Pro.',
    href: '/docs/instructors/class-sites',
  },
  {
    icon: ListChecksIcon,
    title: 'Forms and peer review',
    description: 'Surveys, sign-ups, and team peer review, with responses exported to CSV.',
  },
  {
    icon: PresentationIcon,
    title: 'Slides',
    description: 'Build decks in the browser and present them, with speaker notes and students following along live.',
  },
];

export function EverythingElse() {
  return (
    <section aria-labelledby="everything-else-heading" className="mt-28 lg:mt-36">
      <div className="mx-auto max-w-2xl text-center">
        <h2
          id="everything-else-heading"
          className="text-balance text-[2rem] font-bold leading-[1.15] tracking-tight text-ink-0 sm:text-[2.375rem]"
        >
          And everything else a course needs.
        </h2>
      </div>
      <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {ITEMS.map(({ icon: Icon, title, description, href }) => {
          const body = (
            <>
              <Icon className="h-5 w-5 text-accent" aria-hidden />
              <p className="mt-4 text-[1rem] font-semibold text-ink-0">{title}</p>
              <p className="mt-1.5 text-[0.9375rem] leading-relaxed text-ink-3">{description}</p>
              {href && (
                <span className="mt-4 inline-flex items-center gap-1 text-[0.875rem] font-medium text-accent">
                  Learn more <span aria-hidden>→</span>
                </span>
              )}
            </>
          );
          const box = 'flex h-full flex-col rounded-xl bg-[#F2F1EE] p-6';
          return (
            <li key={title}>
              {href ? (
                <a
                  href={href}
                  className={`${box} transition-colors duration-150 hover:bg-[#EAE8E3] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
                >
                  {body}
                </a>
              ) : (
                <div className={box}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
