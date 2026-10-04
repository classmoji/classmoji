import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckIcon, Loader2Icon, SendIcon } from 'lucide-react';
import { demoUsers } from '../../data/appNav';
import { useDemoTimeline } from '../../hooks/useDemoTimeline';
import type { DemoBase, Step } from '../../types/demo';
import { button, chip, ui } from '../../utils/classes';
import { EASE_OUT, clickAnd, moveTo, offset, typeSteps } from '../../utils/timeline';
import { AppShell } from '../demo-kit/AppShell';
import { Avatar } from '../demo-kit/Avatar';
import { DemoFrame } from '../demo-kit/DemoFrame';

type State = DemoBase & {
  publishing: boolean;
  published: boolean;
  repos: number;
  terminalOpen: boolean;
  command: string;
  pushed: boolean;
  submitted: string[];
};

const STUDENTS = [
  { handle: 'alice', name: 'Alice Wong', initials: 'AW' },
  { handle: 'bob', name: 'Bob Kim', initials: 'BK' },
  { handle: 'chen', name: 'Chen Li', initials: 'CL' },
  { handle: 'dana', name: 'Dana Ortiz', initials: 'DO' },
];

const COMMAND = 'git push origin main';

const initial: State = {
  cursor: null,
  click: 0,
  publishing: false,
  published: false,
  repos: 0,
  terminalOpen: false,
  command: '',
  pushed: false,
  submitted: [],
};

/** What happens after Publish is pressed (shared by autoplay and the real button). */
const publishStory: Step<State>[] = [
  { at: 0, action: (s) => ({ ...s, publishing: true }) },
  { at: 400, action: (s) => ({ ...s, publishing: false, published: true }) },
  { at: 650, action: (s) => ({ ...s, repos: 1 }) },
  { at: 1000, action: (s) => ({ ...s, repos: 2 }) },
  { at: 1350, action: (s) => ({ ...s, repos: 3 }) },
  { at: 1700, action: (s) => ({ ...s, repos: 4 }) },
];

const PUBLISH_AT = 1250;

const steps: Step<State>[] = [
  { at: 500, action: moveTo<State>('publish') },
  { at: PUBLISH_AT, action: clickAnd<State>() },
  ...offset(publishStory, PUBLISH_AT),
  { at: 3300, action: moveTo<State>(null) },
  { at: 3700, action: (s) => ({ ...s, terminalOpen: true }) },
  ...typeSteps<State>(4100, COMMAND, 55, (s, t) => ({ ...s, command: t })),
  { at: 5500, action: (s) => ({ ...s, pushed: true }) },
  { at: 6200, action: (s) => ({ ...s, submitted: ['bob'] }) },
];

export function PublishDemo() {
  const demo = useDemoTimeline({ initial, steps, duration: 8200 });
  const { state: s, act, sequence } = demo;

  const handlePublish = () => {
    if (!s.published && !s.publishing) sequence(publishStory);
  };

  const toggleSubmitted = (handle: string) =>
    act((st) => ({
      ...st,
      submitted: st.submitted.includes(handle)
        ? st.submitted.filter((h) => h !== handle)
        : [...st.submitted, handle],
    }));

  const publishButton = (
    <button
      type="button"
      data-cursor="publish"
      onClick={handlePublish}
      disabled={s.published || s.publishing}
      className={s.published ? button('default') : `${button('primary')} disabled:opacity-100`}
    >
      {s.publishing ? (
        <>
          <Loader2Icon className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Publishing
        </>
      ) : s.published ? (
        <>
          <CheckIcon className="h-3.5 w-3.5 text-accent" strokeWidth={2.5} aria-hidden />
          Published
        </>
      ) : (
        <>
          <SendIcon className="h-3.5 w-3.5" aria-hidden />
          Publish
        </>
      )}
    </button>
  );

  return (
    <DemoFrame
      controller={demo}
      address="classmoji.app/cs52-26f/assignments/hw3"
      label="Demo: publishing HW3 creates a private repository for each student, then a git push marks Bob's work as submitted."
      rest={{ x: 0.5, y: 0.92 }}
    >
      <div className="relative h-full">
        <AppShell active="repositories" role="staff" user={demoUsers.teacher} title="Assignments" actions={publishButton}>
          <section className={`flex h-full flex-col p-5 ${ui.card}`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h5 className="text-[16px] font-bold tracking-tight">HW3: Hash Maps</h5>
                <p className={`mt-1 text-[12px] ${ui.ink3}`}>Due Fri 11:59pm · 4 students · Template hw3-template</p>
              </div>
              <span className={chip(s.published ? 'mint' : 'amber', true)}>{s.published ? 'Published' : 'Draft'}</span>
            </div>

            <div className={`mt-5 flex items-center justify-between border-b pb-2 ${ui.divider} ${ui.tableHead}`}>
              <span>Repository</span>
              <span className="tabular-nums">{s.repos} of 4 created</span>
            </div>

            {s.repos === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-1 pb-10 text-center">
                <p className={`text-[13px] font-semibold ${ui.ink1}`}>No repositories yet</p>
                <p className={`text-[12px] ${ui.ink3}`}>Publish to create one for each student on Github or Gitlab.</p>
              </div>
            ) : (
              <ul>
                <AnimatePresence initial={false}>
                  {STUDENTS.slice(0, s.repos).map((st) => {
                    const done = s.submitted.includes(st.handle);
                    return (
                      <motion.li
                        key={st.handle}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.24, ease: EASE_OUT }}
                        className={`-mx-2 flex h-11 items-center justify-between rounded-md border-b px-2 ${ui.divider} ${ui.rowHover}`}
                      >
                        <div className="flex items-center gap-2.5">
                          <Avatar initials={st.initials} size="sm" />
                          <span className="text-[13px] font-medium">{st.handle}-hw3</span>
                          <span className={`text-[12px] ${ui.ink3}`}>{st.name}</span>
                        </div>
                        <button
                          type="button"
                          data-cursor={`row-${st.handle}`}
                          onClick={() => toggleSubmitted(st.handle)}
                          aria-pressed={done}
                          aria-label={`${st.handle}-hw3: ${done ? 'submitted' : 'not submitted'}`}
                          className={`relative rounded-[6px] ${ui.focus}`}
                        >
                          <AnimatePresence mode="popLayout" initial={false}>
                            <motion.span
                              key={done ? 'done' : 'open'}
                              initial={{ opacity: 0, scale: 0.96 }}
                              animate={{ opacity: 1, scale: 1 }}
                              exit={{ opacity: 0, scale: 0.96 }}
                              transition={{ duration: 0.2, ease: EASE_OUT }}
                              className={chip(done ? 'mint' : 'neutral')}
                            >
                              {done && <CheckIcon className="h-3 w-3" strokeWidth={2.75} aria-hidden />}
                              {done ? 'Submitted · 2h before deadline' : 'Not submitted'}
                            </motion.span>
                          </AnimatePresence>
                        </button>
                      </motion.li>
                    );
                  })}
                </AnimatePresence>
              </ul>
            )}
          </section>
        </AppShell>

        <AnimatePresence>
          {s.terminalOpen && (
            <motion.div
              initial={{ opacity: 0, y: 8, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.96 }}
              transition={{ duration: 0.22, ease: EASE_OUT }}
              className="absolute bottom-6 right-6 w-[292px] overflow-hidden rounded-lg bg-term shadow-float ring-1 ring-black/10 dark:ring-white/10"
            >
              <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5 text-[10.5px] text-white/50">
                <span className="flex gap-1" aria-hidden>
                  <span className="h-1.5 w-1.5 rounded-full bg-white/20" />
                  <span className="h-1.5 w-1.5 rounded-full bg-white/20" />
                  <span className="h-1.5 w-1.5 rounded-full bg-white/20" />
                </span>
                bob · ~/hw3
              </div>
              <div className="px-3 py-2.5 font-mono text-[11.5px] leading-[1.65] text-white/90">
                <div>
                  <span className="text-[#7ee2a0]">bob</span>
                  <span className="text-white/45"> hw3 % </span>
                  {s.command}
                  {!s.pushed && (
                    <span className="demo-caret ml-0.5 inline-block h-3 w-[6px] translate-y-[2px] bg-white/80" />
                  )}
                </div>
                {s.pushed && (
                  <>
                    <div className="text-white/45">Writing objects: 100% (5/5), done.</div>
                    <div className="text-white/45">To github.com:cs52-26f/bob-hw3.git</div>
                    <div>
                      <span className="text-[#7ee2a0]">  a1f9c2e</span>
                      <span className="text-white/70">  main -&gt; main</span>
                    </div>
                  </>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </DemoFrame>
  );
}
