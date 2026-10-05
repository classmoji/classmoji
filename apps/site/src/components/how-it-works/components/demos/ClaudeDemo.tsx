import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  CornerDownLeftIcon,
  FileTextIcon,
  FolderIcon,
  Globe2Icon,
  Loader2Icon,
  MicIcon,
  MoreVerticalIcon,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
} from 'lucide-react';
import { useDemoTimeline } from '../../hooks/useDemoTimeline';
import type { DemoBase, Step } from '../../types/demo';
import { button, chip, ui } from '../../utils/classes';
import { EASE_OUT, clickAnd, moveTo, offset, typeSteps } from '../../utils/timeline';
import { AppTag } from '../demo-kit/AppTag';
import { DemoFrame } from '../demo-kit/DemoFrame';

type ToolStatus = 'idle' | 'running' | 'done';

type State = DemoBase & {
  draft: string;
  message: string;
  sent: boolean;
  tool1: ToolStatus;
  tool2: ToolStatus;
  tool3: ToolStatus;
  reply: boolean;
  hw4: boolean;
  repos: boolean;
  graders: boolean;
};

const PROMPT = 'Create HW4 due Friday, publish it, and split grading between Sam and Priya.';
const REPLY =
  'Done. HW4 is published and due Fri Oct 9 at 11:59pm. I created 42 student repositories, and Sam and Priya will each grade 21.';

const initial: State = {
  cursor: null,
  click: 0,
  draft: '',
  message: '',
  sent: false,
  tool1: 'idle',
  tool2: 'idle',
  tool3: 'idle',
  reply: false,
  hw4: false,
  repos: false,
  graders: false,
};

const sendStory: Step<State>[] = [
  { at: 0, action: s => ({ ...s, sent: true, message: s.draft.trim() || PROMPT, draft: '' }) },
  { at: 500, action: s => ({ ...s, tool1: 'running' }) },
  { at: 1500, action: s => ({ ...s, tool1: 'done', hw4: true }) },
  { at: 1800, action: s => ({ ...s, tool2: 'running' }) },
  { at: 2900, action: s => ({ ...s, tool2: 'done', repos: true }) },
  { at: 3200, action: s => ({ ...s, tool3: 'running' }) },
  { at: 4200, action: s => ({ ...s, tool3: 'done', graders: true }) },
  { at: 4700, action: s => ({ ...s, reply: true }) },
];

const SEND_AT = 3900;

const steps: Step<State>[] = [
  { at: 400, action: moveTo<State>('composer') },
  { at: 900, action: clickAnd<State>() },
  ...typeSteps<State>(1100, PROMPT, 28, (s, t) => ({ ...s, draft: t })),
  { at: 3400, action: moveTo<State>('send') },
  { at: SEND_AT, action: clickAnd<State>() },
  ...offset(sendStory, SEND_AT),
  { at: 4400, action: moveTo<State>(null) },
];

const enter = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.22, ease: EASE_OUT },
};

/** One app window on the desktop: rounded, raised, with its own title bar. */
const WINDOW =
  'rounded-xl bg-panel ring-1 ring-edge shadow-[0_1px_2px_rgba(20,10,40,0.05),0_16px_36px_-18px_rgba(20,25,50,0.35)] dark:bg-panel-dark dark:ring-edge-dark';

function WindowBar({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={`grid h-9 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b px-3 ${ui.divider}`}
    >
      <div className="flex gap-1.5" aria-hidden>
        <span className="h-2.5 w-2.5 rounded-full bg-stone-200 dark:bg-line-2-dark" />
        <span className="h-2.5 w-2.5 rounded-full bg-stone-200 dark:bg-line-2-dark" />
        <span className="h-2.5 w-2.5 rounded-full bg-stone-200 dark:bg-line-2-dark" />
      </div>
      {children}
      <div aria-hidden />
    </div>
  );
}

export function ClaudeDemo() {
  const demo = useDemoTimeline({ initial, steps, duration: 10600 });
  const { state: s, act, sequence } = demo;

  const send = () => {
    if (!s.sent && s.draft.trim()) sequence(sendStory);
  };

  // The real Classmoji MCP tool names.
  const tools: { name: string; status: ToolStatus }[] = [
    { name: 'assignment_create', status: s.tool1 },
    { name: 'repo_publish', status: s.tool2 },
    { name: 'grader_assign_bulk', status: s.tool3 },
  ];

  return (
    <DemoFrame
      controller={demo}
      bare
      label="Demo: a teacher asks Claude to create HW4 due Friday, publish it, and split grading between Sam and Priya; Claude runs three Classmoji tools, provisions 42 student repositories, and HW4 appears in the assignments list with both graders."
      rest={{ x: 0.5, y: 0.55 }}
    >
      {/* Two windows side by side, like on a teacher's desktop: the Claude app and Classmoji in the browser. */}
      <div className={`relative h-full ${ui.ink0}`}>
        <div
          className={`absolute bottom-2 right-0 top-2 flex w-[530px] flex-col overflow-hidden ${WINDOW}`}
        >
          <WindowBar>
            <div
              className={`truncate rounded-md bg-app px-3 py-0.5 text-center text-[11px] ring-1 ring-edge dark:bg-app-dark dark:ring-edge-dark ${ui.ink3}`}
            >
              classmoji.app/cs52-26f/modules
            </div>
          </WindowBar>
          <div className={`flex min-h-0 flex-1 pl-4 ${ui.app}`}>
            <section className="flex min-w-0 flex-1 flex-col py-3 pr-4">
              <div className="flex h-8 items-center justify-between">
                <span className="flex items-center gap-1.5 text-[15px] font-extrabold tracking-tight">
                  <span aria-hidden>🍎</span>classmoji
                </span>
                <span className={chip('neutral')}>CS52 26F</span>
              </div>
              <div className="mt-3 flex items-center justify-between gap-2">
                <h5 className={`text-[15px] font-semibold ${ui.ink1}`}>Modules</h5>
                <div className="flex items-center gap-1.5">
                  <span className="grid h-7 w-7 place-items-center rounded-md border border-line-2 bg-panel dark:border-line-2-dark dark:bg-panel-dark">
                    <SearchIcon className={`h-3.5 w-3.5 ${ui.ink3}`} aria-hidden />
                  </span>
                  <span className={`${button('primary', 'sm')} pointer-events-none`}>
                    <PlusIcon className="h-3.5 w-3.5" aria-hidden />
                    New module
                  </span>
                </div>
              </div>

              <div className={`mt-3 min-h-0 flex-1 overflow-hidden ${ui.card}`}>
                <div className={`flex h-12 items-center gap-2 border-b px-3 ${ui.divider}`}>
                  <ChevronDownIcon className={`h-3.5 w-3.5 ${ui.ink3}`} aria-hidden />
                  <span className={`w-4 text-center text-[12px] font-semibold ${ui.ink3}`}>4</span>
                  <span className="h-5 w-px bg-line dark:bg-line-dark" aria-hidden />
                  <p className="text-[13.5px] font-bold">Data Structures</p>
                  <div className={`ml-auto flex items-center gap-2 text-[11px] ${ui.ink3}`}>
                    <span>{s.hw4 ? '4' : '3'} items</span>
                    <Globe2Icon
                      className="h-3.5 w-3.5 text-sky-ink dark:text-sky-ink-dark"
                      aria-hidden
                    />
                    <span
                      className="relative h-4 w-8 rounded-full bg-accent"
                      aria-label="Visible to students"
                    >
                      <span className="absolute right-0.5 top-0.5 h-3 w-3 rounded-full bg-white" />
                    </span>
                    <MoreVerticalIcon className="h-3.5 w-3.5" aria-hidden />
                  </div>
                </div>

                <div className="px-4 py-3">
                  <p className={`text-[11.5px] ${ui.ink2}`}>
                    Hash maps, heaps, and efficient data structures.
                  </p>
                  <p className={`mt-3 ${ui.tableHead}`}>Content</p>
                  <div
                    className={`mt-1 flex h-9 items-center gap-2 rounded-md px-2 ${ui.rowHover}`}
                  >
                    <FileTextIcon className={`h-3.5 w-3.5 ${ui.ink4}`} aria-hidden />
                    <p className="min-w-0 flex-1 truncate text-[12.5px]">
                      <span className="font-semibold">Page:</span> Hash Maps Overview
                    </p>
                    <AppTag color="green">Published</AppTag>
                    <span className="text-[11.5px] font-medium text-question dark:text-question-dark">
                      Edit
                    </span>
                    <MoreVerticalIcon className={`h-3.5 w-3.5 ${ui.ink4}`} aria-hidden />
                  </div>

                  <p className={`mt-3 ${ui.tableHead}`}>Assignments</p>
                  <div
                    className={`mt-1 flex h-10 items-center gap-2 rounded-md px-2 ${ui.rowHover}`}
                  >
                    <FolderIcon className={`h-3.5 w-3.5 ${ui.ink4}`} aria-hidden />
                    <p className="min-w-0 flex-1 truncate text-[12.5px]">
                      <span className="font-semibold">Assignment:</span> HW3: Hash Maps{' '}
                      <span className={`text-[11px] ${ui.ink3}`}>hw3 · push · 100%</span>
                    </p>
                    <AppTag color="green">Published</AppTag>
                    <span className="text-[11.5px] font-medium text-question dark:text-question-dark">
                      Sync
                    </span>
                    <MoreVerticalIcon className={`h-3.5 w-3.5 ${ui.ink4}`} aria-hidden />
                  </div>

                  <AnimatePresence initial={false}>
                    {s.hw4 && (
                      <motion.div
                        key="hw4"
                        layout
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.25, ease: EASE_OUT }}
                        className={`relative flex h-11 items-center gap-2 rounded-md px-2 ${ui.selected}`}
                      >
                        <motion.span
                          aria-hidden
                          className="absolute inset-0 rounded-md ring-1 ring-accent/45"
                          initial={{ opacity: 1 }}
                          animate={{ opacity: s.graders ? 0 : 1 }}
                          transition={{ duration: 0.25, ease: EASE_OUT }}
                        />
                        <FolderIcon className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
                        <div className="min-w-0 flex-1 leading-tight">
                          <p className="truncate text-[12.5px]">
                            <span className="font-semibold">Assignment:</span> HW4: Heaps
                          </p>
                          <p className={`mt-0.5 truncate text-[10.5px] ${ui.ink3}`}>
                            hw4-heaps · push{s.repos ? ' · 42 repositories' : ''}
                            {s.graders ? ' · Sam + Priya' : ''}
                          </p>
                        </div>
                        <AnimatePresence mode="popLayout" initial={false}>
                          <motion.span
                            key={s.repos ? 'published' : 'draft'}
                            initial={{ opacity: 0, scale: 0.96 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.96 }}
                            transition={{ duration: 0.18, ease: EASE_OUT }}
                            className="inline-flex"
                          >
                            <AppTag color={s.repos ? 'green' : 'orange'}>
                              {s.repos ? 'Published' : 'Draft'}
                            </AppTag>
                          </motion.span>
                        </AnimatePresence>
                        <span className="text-[11.5px] font-medium text-question dark:text-question-dark">
                          {s.repos ? 'Sync' : 'Edit'}
                        </span>
                        <MoreVerticalIcon className={`h-3.5 w-3.5 ${ui.ink4}`} aria-hidden />
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <div className={`mt-2 flex items-center gap-3 text-[11.5px] ${ui.ink3}`}>
                    <span className="h-px flex-1 border-t border-dashed border-line dark:border-line-dark" />
                    <span className="inline-flex items-center gap-1">
                      <PlusIcon className="h-3 w-3" aria-hidden />
                      Add item
                    </span>
                    <span className="h-px flex-1 border-t border-dashed border-line dark:border-line-dark" />
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>

        {/* The Claude desktop app: warm paper, a borderless title bar, serif replies. */}
        <section className="absolute bottom-2 left-0 top-2 flex w-[290px] flex-col overflow-hidden rounded-xl bg-[#FAF9F5] ring-1 ring-[#E8E6DC] shadow-[0_1px_2px_rgba(20,10,40,0.05),0_16px_36px_-18px_rgba(20,25,50,0.35)]">
          <div className="flex h-9 shrink-0 items-center gap-2 px-3 text-[#3D3D3A]">
            <div className="flex gap-1.5" aria-hidden>
              <span className="h-2.5 w-2.5 rounded-full bg-[#DAD8D0]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#DAD8D0]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#DAD8D0]" />
            </div>
            <PanelLeftIcon className="ml-1 h-3.5 w-3.5 text-[#73726C]" aria-hidden />
            <ArrowLeftIcon className="h-3 w-3 text-[#73726C]" aria-hidden />
            <ArrowRightIcon className="h-3 w-3 text-[#B5B3AC]" aria-hidden />
            <span className="ml-1 flex min-w-0 items-center gap-1 truncate text-[11.5px] font-medium">
              CS52 26F
              <ChevronDownIcon className="h-3 w-3 text-[#73726C]" aria-hidden />
            </span>
            <span className="ml-auto rounded-md border border-[#DAD8D0] px-2 py-0.5 text-[10.5px] font-medium">
              Share
            </span>
          </div>

          <div className="flex min-h-0 flex-1 flex-col justify-end gap-2.5 overflow-hidden px-4 pb-3 pt-2 text-[12px] leading-[1.5] text-[#141413]">
            {!s.sent ? (
              <div className="m-auto max-w-[220px] text-center">
                <p className="font-serif text-[17px] leading-snug text-[#141413]">
                  How can I help with CS52 today?
                </p>
              </div>
            ) : (
              <>
                <motion.p
                  {...enter}
                  className="ml-auto max-w-[92%] rounded-xl bg-[#F0EEE6] px-3 py-2 text-[11.5px] text-[#141413]"
                >
                  {s.message}
                </motion.p>
                <motion.p {...enter} className="text-[11px] text-[#73726C]">
                  {s.reply ? 'Used 3 Classmoji tools' : 'Using Classmoji tools…'}
                </motion.p>
                {tools.map(
                  tool =>
                    tool.status !== 'idle' && (
                      <motion.div
                        key={tool.name}
                        {...enter}
                        className="flex items-center gap-2 text-[11px] text-[#3D3D3A]"
                      >
                        <span className="grid h-4 w-4 shrink-0 place-items-center">
                          {tool.status === 'running' ? (
                            <Loader2Icon
                              className="h-3 w-3 animate-spin text-[#73726C]"
                              aria-label="Running"
                            />
                          ) : (
                            <CheckIcon
                              className="h-3 w-3 text-[#73726C]"
                              strokeWidth={2.5}
                              aria-label="Done"
                            />
                          )}
                        </span>
                        <span className="font-mono text-[10.5px]">{tool.name}</span>
                      </motion.div>
                    )
                )}
                {s.reply && (
                  <motion.p
                    {...enter}
                    className="font-serif text-[12.5px] leading-[1.55] text-[#141413]"
                  >
                    {REPLY}
                  </motion.p>
                )}
              </>
            )}
          </div>

          <div className="px-3 pb-2.5">
            <div className="flex items-end gap-2 rounded-2xl border border-[#E1DFD6] bg-white px-3 py-2 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
              <label htmlFor="claude-composer" className="sr-only">
                Reply to Claude
              </label>
              <textarea
                id="claude-composer"
                data-cursor="composer"
                rows={2}
                value={s.draft}
                disabled={s.sent}
                onChange={e => {
                  const value = e.target.value;
                  act(st => ({ ...st, draft: value }));
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder="Reply"
                className="flex-1 resize-none bg-transparent text-[12px] leading-[1.4] text-[#141413] placeholder:text-[#9A9890] focus:outline-none disabled:cursor-default"
              />
              <button
                type="button"
                data-cursor="send"
                onClick={send}
                disabled={s.sent || !s.draft.trim()}
                aria-label="Send"
                className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-[#73726C] transition-colors duration-150 enabled:bg-claude enabled:text-white ${ui.focus}`}
              >
                <CornerDownLeftIcon className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />
              </button>
            </div>
            <div className="mt-1.5 flex items-center justify-between px-1 text-[10.5px] text-[#73726C]">
              <span className="flex items-center gap-2" aria-hidden>
                <PlusIcon className="h-3 w-3" />
                <MicIcon className="h-3 w-3" />
              </span>
              <span>
                <span className="font-medium text-[#3D3D3A]">Opus 5</span> High
              </span>
            </div>
          </div>
        </section>
      </div>
    </DemoFrame>
  );
}
