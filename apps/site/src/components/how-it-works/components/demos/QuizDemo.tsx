import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CircleDashedIcon, RocketIcon, SendHorizontalIcon, SquareTerminalIcon, XIcon } from 'lucide-react';
import { demoUsers } from '../../data/appNav';
import { useDemoTimeline } from '../../hooks/useDemoTimeline';
import type { DemoBase, Step } from '../../types/demo';
import { chip, ui } from '../../utils/classes';
import { EASE_OUT, clickAnd, moveTo, offset, typeSteps } from '../../utils/timeline';
import { AppShell } from '../demo-kit/AppShell';
import { Avatar } from '../demo-kit/Avatar';
import { DemoFrame } from '../demo-kit/DemoFrame';
type State = DemoBase & {
  aiTyping: boolean;
  welcome: boolean;
  analysis1: boolean;
  open1: boolean;
  lines1: number[];
  q1: boolean;
  a1: string;
  analysis2: boolean;
  open2: boolean;
  q2: boolean;
  a2: string;
  evaluated: boolean;
  meter: number;
  draft: string;
};
const WELCOME = "Welcome to your code review quiz on HW3: Hash Maps! I'll look at your repository first, then ask you 2 questions about your implementation.";
const Q1 = 'Why did you use a hash map in solve()?';
const A1 = 'Lookups are O(1) on average, so checking whether the complement is already in seen keeps solve() linear instead of quadratic.';
const Q2 = 'Nice. What happens if two keys hash to the same bucket?';
const A2 = 'Python handles that for me. I think the old value just gets replaced?';
const CODE = ['def solve(nums, target):', '    seen = {}', '    for i, n in enumerate(nums):', '        need = target - n', '        if need in seen:', '            return [seen[need], i]', '        seen[n] = i', '    return []'];
const TOKEN = /(\b(?:def|for|in|if|return)\b|\benumerate\b|\bsolve\b)/g;
const initial: State = {
  cursor: null,
  click: 0,
  aiTyping: false,
  welcome: false,
  analysis1: false,
  open1: false,
  lines1: [],
  q1: false,
  a1: '',
  analysis2: false,
  open2: false,
  q2: false,
  a2: '',
  evaluated: false,
  meter: 0,
  draft: ''
};
const sendAnswer1 = (s: State): State => ({
  ...s,
  a1: s.draft.trim() || A1,
  draft: '',
  open1: false,
  meter: 58
});
const sendAnswer2 = (s: State): State => ({
  ...s,
  a2: s.draft.trim() || A2,
  draft: '',
  open2: false,
  meter: 72
});

/** After the first answer is sent (shared by autoplay and the real Send button). */
const afterAnswer1: Step<State>[] = [{
  at: 0,
  action: sendAnswer1
}, {
  at: 300,
  action: s => ({
    ...s,
    aiTyping: true
  })
}, {
  at: 700,
  action: s => ({
    ...s,
    analysis2: true,
    open2: true
  })
}, {
  at: 1100,
  action: s => ({
    ...s,
    aiTyping: false,
    q2: true
  })
}];
const afterAnswer2: Step<State>[] = [{
  at: 0,
  action: sendAnswer2
}, {
  at: 300,
  action: s => ({
    ...s,
    aiTyping: true
  })
}, {
  at: 900,
  action: s => ({
    ...s,
    aiTyping: false,
    evaluated: true,
    meter: 80
  })
}];
const SEND1_AT = 5000;
const SEND2_AT = 8700;
const steps: Step<State>[] = [{
  at: 0,
  action: s => ({
    ...s,
    aiTyping: true
  })
}, {
  at: 400,
  action: s => ({
    ...s,
    aiTyping: false,
    welcome: true
  })
}, {
  at: 800,
  action: s => ({
    ...s,
    analysis1: true,
    open1: true
  })
}, {
  at: 1100,
  action: s => ({
    ...s,
    lines1: [2],
    meter: 12
  })
}, {
  at: 1400,
  action: s => ({
    ...s,
    lines1: [2, 7],
    meter: 24
  })
}, {
  at: 1900,
  action: s => ({
    ...s,
    q1: true
  })
}, {
  at: 2200,
  action: moveTo<State>('composer')
}, {
  at: 2600,
  action: clickAnd<State>()
}, ...typeSteps<State>(2700, A1, 85, (s, t) => ({
  ...s,
  draft: t
}), 'word'), {
  at: 3600,
  action: s => ({
    ...s,
    meter: 40
  })
}, {
  at: 4600,
  action: moveTo<State>('send')
}, {
  at: SEND1_AT,
  action: clickAnd<State>()
}, ...offset(afterAnswer1, SEND1_AT), {
  at: 6300,
  action: moveTo<State>('composer')
}, {
  at: 6700,
  action: clickAnd<State>()
}, ...typeSteps<State>(6800, A2, 100, (s, t) => ({
  ...s,
  draft: t
}), 'word'), {
  at: 8300,
  action: moveTo<State>('send')
}, {
  at: SEND2_AT,
  action: clickAnd<State>()
}, ...offset(afterAnswer2, SEND2_AT), {
  at: 10100,
  action: moveTo<State>('eval')
}];
const enter = {
  initial: {
    opacity: 0,
    y: 6
  },
  animate: {
    opacity: 1,
    y: 0
  },
  transition: {
    duration: 0.22,
    ease: EASE_OUT
  }
};
const aiBox = `rounded-lg border bg-panel px-4 py-3 dark:bg-panel-dark ${ui.divider}`;
export function QuizDemo() {
  const demo = useDemoTimeline({
    initial,
    steps,
    duration: 11000
  });
  const {
    state: s,
    act,
    sequence
  } = demo;
  const awaitingA1 = s.q1 && !s.a1;
  const awaitingA2 = s.q2 && !s.a2;
  const canSend = (awaitingA1 || awaitingA2) && s.draft.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    sequence(awaitingA1 ? afterAnswer1 : afterAnswer2);
  };
  const renderCode = (from: number, to: number, highlight: number[]) => <div className="mt-2 overflow-hidden rounded-md border border-line bg-panel py-1.5 font-mono text-[11px] leading-[20px] dark:border-line-dark dark:bg-panel-dark">
      {CODE.slice(from - 1, to).map((line, i) => {
      const n = from + i;
      const on = highlight.includes(n);
      return <div key={n} className={`flex whitespace-pre border-l-2 pr-2 transition-colors duration-200 ${on ? `border-accent ${ui.selected}` : 'border-transparent'}`}>
            <span className={`w-8 shrink-0 select-none pr-3 text-right ${ui.ink4}`}>{n}</span>
            <span className={ui.ink0}>
              {line.split(TOKEN).map((part, pi) => {
            if (/^(def|for|in|if|return)$/.test(part)) return <span key={pi} className="text-[#cf222e] dark:text-[#ff7b72]">
                      {part}
                    </span>;
            if (/^(enumerate|solve)$/.test(part)) return <span key={pi} className="text-[#8250df] dark:text-[#d2a8ff]">
                      {part}
                    </span>;
            return <span key={pi}>{part}</span>;
          })}
            </span>
          </div>;
    })}
    </div>;
  const renderAnalysis = (open: boolean, toggle: () => void, label: string, from: number, to: number, highlight: number[]) => <motion.div {...enter} className="rounded-lg border border-line bg-app dark:border-line-dark dark:bg-app-dark">
      <button type="button" onClick={toggle} aria-expanded={open} className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] ${ui.ink3} ${ui.focus}`}>
        {open ? <ChevronDownIcon className="h-3.5 w-3.5" aria-hidden /> : <ChevronRightIcon className="h-3.5 w-3.5" aria-hidden />}
        <RocketIcon className="h-3 w-3 text-question dark:text-question-dark" aria-hidden />
        {label}
        {open && highlight.length > 0 && <span className={`ml-auto text-[11px] ${ui.ink4}`}>
            solve.py · L{[...highlight].sort((a, b) => a - b).join(', L')}
          </span>}
      </button>
      <AnimatePresence initial={false}>
        {open && <motion.div initial={{
        height: 0,
        opacity: 0
      }} animate={{
        height: 'auto',
        opacity: 1
      }} exit={{
        height: 0,
        opacity: 0
      }} transition={{
        duration: 0.24,
        ease: EASE_OUT
      }} className="overflow-hidden">
            <div className="px-3 pb-3">{renderCode(from, to, highlight)}</div>
          </motion.div>}
      </AnimatePresence>
    </motion.div>;
  const aiAvatar = <span aria-hidden className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-quiz-soft text-[13px] ring-1 ring-quiz-ring dark:bg-[#33290f] dark:ring-[#5a4718]">
      📝
    </span>;
  const renderQuestion = (index: number, text: string) => <motion.div {...enter} className="flex items-start gap-2.5">
      {aiAvatar}
      <div className={`max-w-[470px] flex-1 ${aiBox}`}>
        <div className="rounded-md border border-line px-3.5 py-2.5 dark:border-line-dark">
          <p className="flex items-center gap-1.5 border-b border-question-line pb-2 text-[13px] font-semibold text-question dark:border-question-line-dark dark:text-question-dark">
            <span className="h-3.5 w-3.5" aria-hidden />
            Question {index} of 2
          </p>
          <p className={`pt-2 text-[12.5px] leading-[1.5] ${ui.ink0}`}>{text}</p>
        </div>
      </div>
    </motion.div>;
  const renderAnswer = (text: string) => <motion.div {...enter} className="flex items-start justify-end gap-2.5">
      <p className={`max-w-[400px] rounded-lg border bg-panel-hover px-3.5 py-2.5 text-[12.5px] leading-[1.5] dark:bg-panel-hover-dark ${ui.divider} ${ui.ink0}`}>
        {text}
      </p>
      <Avatar initials="BK" size="sm" />
    </motion.div>;
  return <DemoFrame controller={demo} address="classmoji.app/cs52-26f/quizzes/hw3" label="Demo: a code review quiz analyzes Bob's solve() function, highlights the lines it is asking about, takes his typed answers, and rates his understanding at 80%." rest={{
    x: 0.6,
    y: 0.5
  }}>
      <div className="relative h-full overflow-hidden">
        <AppShell active="quizzes" role="student" user={demoUsers.student} title="Quizzes">
          <div className={`h-full ${ui.card}`} />
        </AppShell>
        <div className="absolute inset-0 bg-black/40" aria-hidden />

        <section aria-label="Code review quiz" className={`absolute inset-y-0 right-0 flex w-[624px] flex-col bg-panel shadow-float dark:bg-panel-dark ${ui.ink0}`}>
          <header className={`flex h-11 shrink-0 items-center gap-2.5 border-b bg-app px-4 dark:bg-app-dark ${ui.divider}`}>
            <XIcon className={`h-4 w-4 ${ui.ink3}`} aria-hidden />
            <span aria-hidden className="text-[14px]">
              🧑‍💻
            </span>
            <h4 className="text-[14px] font-semibold">HW3: Hash Maps</h4>
            <span className={`text-[12px] font-medium ${ui.ink3}`}>(Code review)</span>
            <div className="ml-auto flex items-center gap-2">
              <span className={`text-[11px] ${ui.ink3}`}>Understanding</span>
              <div className="h-1.5 w-20 overflow-hidden rounded-full bg-bar dark:bg-bar-dark" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={s.meter} aria-label="Understanding">
                <motion.div className="h-full rounded-full bg-accent" initial={false} animate={{
                width: `${s.meter}%`
              }} transition={{
                duration: 0.3,
                ease: EASE_OUT
              }} />
              </div>
              <span className="w-8 text-right text-[11.5px] font-semibold tabular-nums">{s.meter}%</span>
            </div>
          </header>

          <div className="flex min-h-0 flex-1 flex-col justify-end gap-3 overflow-hidden px-5 py-4">
            {s.welcome && <motion.div {...enter} className="flex items-start gap-2.5">
                {aiAvatar}
                <p className={`max-w-[470px] text-[12.5px] leading-[1.5] ${aiBox}`}>{WELCOME}</p>
              </motion.div>}
            {s.analysis1 && renderAnalysis(s.open1, () => act(st => ({
            ...st,
            open1: !st.open1
          })), 'Code Analysis (4 steps)', 1, 8, s.lines1)}
            {s.q1 && renderQuestion(1, Q1)}
            {s.a1 && renderAnswer(s.a1)}
            {s.analysis2 && renderAnalysis(s.open2, () => act(st => ({
            ...st,
            open2: !st.open2
          })), 'Code Analysis (2 steps)', 4, 7, [5, 6])}
            {s.q2 && renderQuestion(2, Q2)}
            {s.a2 && renderAnswer(s.a2)}
            {s.aiTyping && <div className="flex items-start gap-2.5" aria-label="Moji is thinking">
                {aiAvatar}
                <div className={`flex items-center gap-1 ${aiBox}`}>
                  {[0, 1, 2].map(d => <span key={d} className="demo-typing-dot h-1.5 w-1.5 rounded-full bg-ink-4 dark:bg-inkd-4" style={{
                animationDelay: `${d * 160}ms`
              }} />)}
                </div>
              </div>}
            {s.evaluated && <motion.div {...enter} className="flex items-start gap-2.5">
                {aiAvatar}
                <div data-cursor="eval" className={`max-w-[470px] flex-1 ${aiBox}`}>
                  <div className="rounded-md border border-mint-line bg-mint-bg px-3.5 py-2.5 dark:border-mint-line-dark dark:bg-mint-bg-dark">
                    <div className="flex items-center justify-between">
                      <p className="text-[13px] font-semibold">Quiz complete</p>
                      <p className="text-[13px] font-bold tabular-nums text-mint-ink dark:text-mint-ink-dark">80%</p>
                    </div>
                    <p className={`mt-1 text-[12.5px] ${ui.ink1}`}>
                      Strong grasp of time complexity. Missed the collision case.
                    </p>
                    <div className="mt-2 flex gap-1.5">
                      <span className={chip('mint')}>
                        <CheckIcon className="h-2.5 w-2.5" strokeWidth={3} aria-hidden />
                        Big-O
                      </span>
                      <span className={chip('amber')}>
                        <CircleDashedIcon className="h-2.5 w-2.5" strokeWidth={2.5} aria-hidden />
                        Collisions
                      </span>
                    </div>
                  </div>
                </div>
              </motion.div>}
          </div>

          <div className="shrink-0 px-4 pb-4">
            <div className={`overflow-hidden rounded-lg border ${ui.divider}`}>
              <div className={`flex items-center gap-2 border-b bg-app px-2.5 py-1.5 dark:bg-app-dark ${ui.divider}`}>
                <span className="inline-flex h-[26px] items-center gap-6 rounded-[7px] border border-line-2 bg-panel px-2 text-[12px] dark:border-line-2-dark dark:bg-panel-dark">
                  Python
                  <ChevronDownIcon className={`h-3 w-3 ${ui.ink3}`} aria-hidden />
                </span>
                <span className="inline-flex h-[26px] items-center gap-1.5 rounded-[7px] bg-quiz px-2.5 text-[12px] font-medium text-ink-0">
                  <SquareTerminalIcon className="h-3.5 w-3.5" aria-hidden />
                  Insert Code
                </span>
                <span className={`ml-auto text-[11px] ${ui.ink3}`}>Click Send to submit your message</span>
              </div>
              <label htmlFor="quiz-answer" className="sr-only">
                Your answer
              </label>
              <textarea id="quiz-answer" data-cursor="composer" rows={2} value={s.draft} onChange={e => {
              const value = e.target.value;
              act(st => ({
                ...st,
                draft: value
              }));
            }} placeholder={awaitingA1 || awaitingA2 ? 'Type your answer' : ''} className={`block w-full resize-none bg-panel px-3 py-2.5 text-[12.5px] leading-[1.5] placeholder:text-ink-4 focus:outline-none dark:bg-panel-dark dark:placeholder:text-inkd-4 ${ui.ink0}`} />
              <div className={`flex justify-end border-t px-2.5 py-2 ${ui.divider}`}>
                <button type="button" data-cursor="send" onClick={send} disabled={!canSend} className={`inline-flex h-8 items-center gap-1.5 rounded-md bg-quiz px-3.5 text-[13px] font-medium text-ink-0 transition-colors duration-150 hover:bg-quiz-hover disabled:cursor-default disabled:opacity-60 disabled:hover:bg-quiz ${ui.focus}`}>
                  <SendHorizontalIcon className="h-3.5 w-3.5" aria-hidden />
                  Send
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </DemoFrame>;
}
