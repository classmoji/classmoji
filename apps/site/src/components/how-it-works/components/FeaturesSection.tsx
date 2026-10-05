import React from 'react';
import { features } from '../data/features';
import type { FeatureId } from '../types/feature';
import { DoodleHighlight } from './DoodleHighlight';
import { EverythingElse } from './EverythingElse';
import { Faq } from './Faq';
import { FeatureRow } from './FeatureRow';
import { ClaudeDemo } from './demos/ClaudeDemo';
import { GradingDemo } from './demos/GradingDemo';
import { PublishDemo } from './demos/PublishDemo';
import { QuizDemo } from './demos/QuizDemo';
import { GithubMark } from './demo-kit/GithubMark';
import { GitlabMark } from './demo-kit/GitlabMark';

const DEMOS: Record<FeatureId, () => React.JSX.Element> = {
  publish: PublishDemo,
  grading: GradingDemo,
  quiz: QuizDemo,
  claude: ClaudeDemo,
};

export function FeaturesSection() {
  return (
    <section
      aria-labelledby="how-it-works-heading"
      className="w-full bg-page px-5 py-24 dark:bg-page-dark sm:px-8 lg:py-32"
    >
      <div className="mx-auto max-w-[1440px]">
        <header className="mx-auto max-w-2xl text-center">
          <p className="text-[0.875rem] font-semibold text-[#21883D] dark:text-[#6BE39B]">
            Open source · Built at Dartmouth College
          </p>
          <h2
            id="how-it-works-heading"
            className="mt-3 text-balance text-[2.25rem] font-bold leading-[1.1] tracking-tight text-ink-0 dark:text-inkd-0 sm:text-[2.75rem]"
          >
            Teaching on{' '}
            <DoodleHighlight tone="github" delay={0.35}>
              Github
            </DoodleHighlight>{' '}
            and{' '}
            <DoodleHighlight tone="gitlab" delay={0.8}>
              Gitlab
            </DoodleHighlight>{' '}
            should feel this good. <span aria-hidden>😌</span>
          </h2>
        </header>

        <div className="mt-7 flex justify-center">
          <div className="inline-flex max-w-full items-center gap-2.5 rounded-full bg-panel px-4 py-2.5 text-[0.9375rem] text-ink-2 shadow-card ring-1 ring-edge dark:bg-panel-dark dark:text-inkd-2 dark:ring-neutral-800">
            <span className="flex shrink-0 items-center gap-1.5" aria-hidden>
              <GithubMark className="h-[18px] w-[18px] text-ink-0 dark:text-inkd-0" />
              <GitlabMark className="h-[18px] w-[18px] text-[#FC6D26]" />
            </span>
            <span>Works with Github, gitlab.com, and your own self-hosted Gitlab.</span>
          </div>
        </div>

        <div className="mt-20 flex flex-col gap-14 lg:mt-24 lg:gap-24">
          {features.map((feature, i) => {
            const Demo = DEMOS[feature.id];
            return (
              <FeatureRow key={feature.id} feature={feature} reversed={i % 2 === 1}>
                <Demo />
              </FeatureRow>
            );
          })}
        </div>

        <div className="mx-auto max-w-7xl">
          <EverythingElse />
        </div>

        <Faq />

        <div className="mx-auto mt-28 max-w-2xl text-center lg:mt-36">
          <h2 className="text-balance text-[2rem] font-bold leading-[1.15] tracking-tight text-ink-0 dark:text-inkd-0 sm:text-[2.375rem]">
            Start your class on Classmoji.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-pretty text-[1.0625rem] leading-relaxed text-ink-2 dark:text-inkd-2">
            Create a classroom with Github or Gitlab. Students join with an invite link.
          </p>
          <div className="mt-7 flex justify-center">
            <a
              href="https://app.classmoji.io/"
              className="inline-flex h-11 items-center justify-center rounded-lg bg-[#21883D] px-6 text-[0.9375rem] font-medium text-white transition-colors duration-150 hover:bg-[#1B7334] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-page dark:focus-visible:ring-offset-page-dark"
            >
              Create an account
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
