/**
 * One-question dialog shown on the classroom picker to anyone who has not yet
 * answered it. Asks the first pending question; both "Continue" and "Skip"
 * POST to /api/survey/answer, which is what makes the prompt go away (the
 * loader revalidates and stops sending the question). With several pending
 * questions the dialog re-renders for the next one after each revalidation.
 *
 * An option with a detailPrompt reveals a free-text field under it. Hand-rolled
 * on the design tokens (same approach as the landing screen and the page peek
 * drawer) rather than antd, so it matches the picker it sits on.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFetcher } from 'react-router';
import { Button } from '@classmoji/ui-components';
import { SURVEY_SKIPPED, type SurveyQuestion } from '@classmoji/utils';

interface SurveyPromptProps {
  questions: SurveyQuestion[];
}

export function SurveyPrompt({ questions }: SurveyPromptProps) {
  const question = questions[0];
  const fetcher = useFetcher();
  const [answer, setAnswer] = useState<string | null>(null);
  const [detail, setDetail] = useState('');
  // Null until mounted so server and first client render agree (no portal in SSR).
  const [mounted, setMounted] = useState(false);
  const [entered, setEntered] = useState(false);

  // A different question means fresh inputs.
  useEffect(() => {
    setAnswer(null);
    setDetail('');
  }, [question?.key]);

  // Mount, then fade in on the next frame.
  useEffect(() => {
    setMounted(true);
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  if (!question || !mounted) return null;

  const busy = fetcher.state !== 'idle';
  const picked = question.options.find(o => o.value === answer) ?? null;
  const canContinue = picked != null && !busy;

  const submit = (value: string) => {
    fetcher.submit(
      { question_key: question.key, answer: value, detail: picked?.detailPrompt ? detail : null },
      { method: 'POST', action: '/api/survey/answer', encType: 'application/json' }
    );
  };

  const pick = (value: string) => {
    if (value !== answer) setDetail('');
    setAnswer(value);
  };

  return createPortal(
    <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4">
      <div
        aria-hidden
        className={`absolute inset-0 bg-gray-900/35 transition-opacity duration-200 motion-reduce:transition-none dark:bg-black/60 ${
          entered ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="survey-prompt-title"
        className={`card relative w-full max-w-[460px] max-h-[calc(100vh-2rem)] overflow-y-auto p-6 transition-all duration-200 ease-out motion-reduce:transition-none ${
          entered ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
        }`}
      >
        <h2 id="survey-prompt-title" className="text-lg font-semibold text-ink-0 m-0">
          {question.prompt}
        </h2>
        <p className="text-sm text-ink-3 mt-1 mb-5">
          One quick question so we know what is working. You will not be asked again.
        </p>

        <div
          role="radiogroup"
          aria-labelledby="survey-prompt-title"
          className="flex flex-col gap-2"
        >
          {question.options.map(opt => {
            const selected = answer === opt.value;
            return (
              <div key={opt.value}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={busy}
                  onClick={() => pick(opt.value)}
                  className={`w-full flex items-center gap-3 text-left rounded-xl border px-3.5 py-2.5 text-sm font-medium transition-colors cursor-pointer disabled:cursor-default ${
                    selected
                      ? 'border-accent bg-accent-soft text-accent-ink'
                      : 'border-line bg-bg-0 text-ink-1 hover:bg-bg-1 hover:border-line-strong'
                  }`}
                >
                  <span aria-hidden className="text-base leading-none">
                    {opt.emoji}
                  </span>
                  {opt.label}
                </button>
                {selected && opt.detailPrompt && (
                  <div className="mt-2 ml-4 pl-3 border-l-2 border-accent-soft-2">
                    {opt.detailSuggestions && (
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {opt.detailSuggestions.map(s => {
                          const on = detail === s;
                          return (
                            <button
                              key={s}
                              type="button"
                              aria-pressed={on}
                              disabled={busy}
                              onClick={() => setDetail(on ? '' : s)}
                              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors cursor-pointer disabled:cursor-default ${
                                on
                                  ? 'border-accent bg-accent text-white'
                                  : 'border-line bg-bg-0 text-ink-1 hover:bg-bg-1 hover:border-line-strong'
                              }`}
                            >
                              {s}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <input
                      type="text"
                      autoFocus={!opt.detailSuggestions}
                      maxLength={200}
                      placeholder={opt.detailSuggestions ? 'Or somewhere else…' : opt.detailPrompt}
                      value={detail}
                      onChange={e => setDetail(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && canContinue) submit(opt.value);
                      }}
                      className="w-full rounded-xl border border-line bg-bg-0 px-3.5 py-2 text-sm text-ink-0 placeholder:text-ink-4 outline-none focus:border-accent"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between mt-6">
          <Button variant="ghost" disabled={busy} onClick={() => submit(SURVEY_SKIPPED)}>
            Skip
          </Button>
          <Button
            variant="primary"
            disabled={!canContinue}
            className="disabled:opacity-50 disabled:cursor-default"
            onClick={() => canContinue && submit(picked.value)}
          >
            {busy ? 'Saving…' : 'Continue'}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default SurveyPrompt;
