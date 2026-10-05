import React from 'react';
import type { ReactNode } from 'react';
import type { Feature } from '../types/feature';

type FeatureRowProps = {
  feature: Feature;
  /** Copy on the left and the stage on the right; rows alternate. */
  reversed: boolean;
  children: ReactNode;
};

/**
 * One feature as a single panel: the app window floats on a tinted stage, and
 * the copy sits low beside it, title and description read as one sentence
 * (title dark, description muted).
 */
export function FeatureRow({ feature, reversed, children }: FeatureRowProps) {
  return (
    <article className="grid gap-8 rounded-xl bg-[#F2F1EE] p-3 sm:p-4 lg:grid-cols-12 lg:gap-12 lg:p-5">
      <div
        className={`flex items-center justify-center rounded-lg bg-[#DCDDE0] px-4 py-8 sm:px-10 sm:py-10 lg:col-span-9 lg:px-12 lg:py-12 ${reversed ? 'lg:order-2' : ''}`}
      >
        <div className="w-full max-w-[960px]">{children}</div>
      </div>
      <div
        className={`flex flex-col justify-end px-3 pb-6 sm:px-4 lg:col-span-3 lg:pb-14 ${reversed ? 'lg:order-1 lg:pl-8' : 'lg:pr-8'}`}
      >
        <p className="text-[0.875rem] font-semibold text-accent">{feature.kicker}</p>
        <h3 className="mt-3 text-pretty text-[1.5rem] leading-[1.3] tracking-tight">
          <span className="font-semibold text-ink-0">{feature.title}</span>{' '}
          <span className="text-ink-3">{feature.description}</span>
        </h3>
        {feature.link && (
          <a
            href={feature.link.href}
            className="mt-6 inline-flex w-fit items-center gap-1.5 rounded-md text-[1.0625rem] font-medium text-accent transition-colors duration-150 hover:text-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {feature.link.label}
            <span aria-hidden>→</span>
          </a>
        )}
      </div>
    </article>
  );
}
