import React from 'react';
import { Alert, Avatar, Button, Card, ConfigProvider, Progress, Select } from 'antd';
import {
  CheckCircleOutlined,
  CloseOutlined,
  CodeOutlined,
  FileTextOutlined,
  QuestionCircleOutlined,
  RocketOutlined,
  SendOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import { demoUsers } from '../../data/appNav';
import { useDemoTimeline } from '../../hooks/useDemoTimeline';
import type { DemoBase, Step } from '../../types/demo';
import { clickAnd, moveTo, typeSteps } from '../../utils/timeline';
import { AppAntd } from '../demo-kit/AppAntd';
import { AppShell } from '../demo-kit/AppShell';
import { DemoFrame } from '../demo-kit/DemoFrame';

/*
 * A copy of the webapp's code review quiz, as a student takes it:
 * - the attempt drawer (routes/student.$class.quizzes.$quizId.attempt.$attemptId):
 *   90% wide, 🧑‍💻 and the quiz name in its header;
 * - the chat (components/features/quiz/QuizChat.tsx): 📝 assistant bubbles,
 *   the files read under "Code Analysis (N steps)" (StepList), each question in
 *   a QuestionCard quoting the student's own code with its path and lines, the
 *   feedback with Try Again / Next → (NextStepButtons), a "completed question
 *   N" row between questions (ProgressDivider), the results at the end
 *   (QuizResults);
 * - the composer (routes/student.$class.quizzes/ChatEditor.tsx).
 * No score is shown until the end. Code review reads the student's repository
 * only when the instructor turns it on for the quiz.
 */

type Phase =
  | 'start'
  | 'welcome'
  | 'reading1'
  | 'q1'
  | 'a1'
  | 'feedback1'
  | 'next1'
  | 'q2'
  | 'a2'
  | 'feedback2'
  | 'done';

type State = DemoBase & {
  phase: Phase;
  /** Files listed so far in the open step list. */
  files: number;
  draft: string;
  thinking: string | null;
};

const ORDER: Phase[] = [
  'start',
  'welcome',
  'reading1',
  'q1',
  'a1',
  'feedback1',
  'next1',
  'q2',
  'a2',
  'feedback2',
  'done',
];
const reached = (s: State, phase: Phase) => ORDER.indexOf(s.phase) >= ORDER.indexOf(phase);

const QUIZ = 'HW3: Hash Maps';
const WELCOME = `Welcome to your code review quiz on ${QUIZ}! I'll look at your repository first, then ask you 2 questions about your implementation.`;
const FILES = ['README.md', 'solve.py', 'tests/test_solve.py'];
const Q1 =
  'Why does solve() store each number in seen before moving on, and what does that buy you?';
const A1 =
  'So the next numbers can find their complement in O(1). It keeps solve() linear instead of checking every pair.';
const FEEDBACK1 =
  "Exactly. Each lookup in seen is O(1) on average, so one pass is enough. That's the whole point of the hash map here.";
const Q2 = 'What happens in seen if two different numbers hash to the same bucket?';
const A2 = 'Python handles that for me. I think the old value just gets replaced?';
const FEEDBACK2 =
  'Not quite. A collision does not replace anything: Python probes for another slot, and both keys stay in the dict. Only an equal key overwrites a value.';

const CODE1 = {
  path: 'solve.py',
  lines: '3–6',
  code: [
    'for i, n in enumerate(nums):',
    '    need = target - n',
    '    if need in seen:',
    '        return [seen[need], i]',
  ],
};
const CODE2 = { path: 'solve.py', lines: '7', code: ['    seen[n] = i'] };

const initial: State = {
  cursor: null,
  click: 0,
  phase: 'start',
  files: 0,
  draft: '',
  thinking: 'Thinking...',
};

const to =
  (phase: Phase, extra: Partial<State> = {}) =>
  (s: State): State => ({ ...s, phase, ...extra });

const steps: Step<State>[] = [
  { at: 700, action: to('welcome', { thinking: null }) },
  { at: 1000, action: to('reading1', { thinking: 'Exploring code...', files: 1 }) },
  { at: 1300, action: s => ({ ...s, files: 2 }) },
  { at: 1600, action: s => ({ ...s, files: 3 }) },
  { at: 2100, action: to('q1', { thinking: null }) },
  { at: 2500, action: moveTo<State>('composer') },
  ...typeSteps<State>(3000, A1, 90, (s, draft) => ({ ...s, draft }), 'word'),
  { at: 4800, action: moveTo<State>('send') },
  { at: 5300, action: clickAnd<State>(to('a1', { draft: '', thinking: 'Thinking...' })) },
  { at: 6100, action: to('feedback1', { thinking: null }) },
  { at: 6600, action: moveTo<State>('next') },
  { at: 7200, action: clickAnd<State>(to('next1', { thinking: 'Exploring code...' })) },
  { at: 8100, action: to('q2', { thinking: null }) },
  { at: 8400, action: moveTo<State>('composer') },
  ...typeSteps<State>(8800, A2, 90, (s, draft) => ({ ...s, draft }), 'word'),
  { at: 10200, action: moveTo<State>('send') },
  { at: 10700, action: clickAnd<State>(to('a2', { draft: '', thinking: 'Thinking...' })) },
  { at: 11500, action: to('feedback2', { thinking: null }) },
  { at: 12000, action: moveTo<State>('next') },
  { at: 12600, action: clickAnd<State>(s => ({ ...s, thinking: 'Thinking...' })) },
  { at: 13400, action: to('done', { thinking: null }) },
  { at: 13600, action: moveTo<State>(null) },
];

/** The app's antd theme at the demo's scale. */
function Compact({ children }: { children: React.ReactNode }) {
  return (
    <AppAntd>
      <ConfigProvider theme={{ token: { fontSize: 12, controlHeight: 28 } }}>
        {children}
      </ConfigProvider>
    </AppAntd>
  );
}

const PY = /(\b(?:for|in|if|return)\b|\benumerate\b|\d+)/g;

/** Github-light colors, as the card's highlight.js theme draws Python. */
function Code({ lines }: { lines: string[] }) {
  return (
    <pre className="m-0 overflow-hidden rounded-md border border-[#d0d7de] bg-[#f6f8fa] p-2.5 font-sans text-[11px] leading-[1.5] text-[#1f2328]">
      {lines.map((line, i) => (
        <div key={i}>
          {line.split(PY).map((part, j) =>
            /^(for|in|if|return)$/.test(part) ? (
              <span key={j} className="text-[#cf222e]">
                {part}
              </span>
            ) : part === 'enumerate' ? (
              <span key={j} className="text-[#0550ae]">
                {part}
              </span>
            ) : (
              <React.Fragment key={j}>{part}</React.Fragment>
            )
          )}
          {line === '' ? ' ' : null}
        </div>
      ))}
    </pre>
  );
}

const AssistantAvatar = () => (
  <Avatar
    size={28}
    style={{ backgroundColor: '#fffdf5', fontSize: 16, border: '1px solid #ffd66b', flexShrink: 0 }}
  >
    📝
  </Avatar>
);

function AssistantBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <AssistantAvatar />
      <div className="max-w-[70%] break-words rounded-lg border border-[#d9d9d9] bg-white px-3 py-2 text-[12px] leading-[1.5] text-gray-900">
        {children}
      </div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex items-start justify-end gap-2">
      <div className="max-w-[70%] break-words rounded-lg bg-[#f0f2f5] px-3 py-2 text-[12px] leading-[1.5] text-gray-900">
        {text}
      </div>
      <Avatar size={28} style={{ backgroundColor: '#52c41a', flexShrink: 0 }}>
        B
      </Avatar>
    </div>
  );
}

/** StepList: "Code Analysis (N steps)", the files read, open only while reading. */
function Steps({ files, open }: { files: number; open: boolean }) {
  return (
    <div className="w-[70%] overflow-hidden rounded-lg border border-[#d9d9d9] bg-[#fafafa] text-[11.5px]">
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-gray-500">
        <span className={`text-[9px] transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        <RocketOutlined style={{ color: '#3b82f6' }} />
        Code Analysis ({files} {files === 1 ? 'step' : 'steps'})
      </div>
      {open && (
        <ul className="m-0 list-none border-t border-[#d9d9d9] bg-white px-3 py-1.5">
          {FILES.slice(0, files).map(f => (
            <li
              key={f}
              className="flex items-center gap-2 py-0.5 font-sans text-[11px] text-gray-500"
            >
              <FileTextOutlined style={{ color: '#10b981' }} />
              {f}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** QuestionCard: the student's own code, its path and lines, then the question. */
function Question({ n, code, text }: { n: number; code: typeof CODE1; text: string }) {
  return (
    <div className="flex items-start gap-2">
      <AssistantAvatar />
      <div className="max-w-[70%] rounded-lg border border-[#d9d9d9] bg-white p-2">
        <div className="rounded-lg border border-[#91caff] bg-[#e6f4ff] px-3 py-2.5">
          <div className="mb-2 flex items-center gap-1.5 border-b border-[#91caff] pb-1.5">
            <QuestionCircleOutlined style={{ fontSize: 15, color: '#1890ff' }} />
            <span className="text-[12.5px] font-semibold text-[#0958d9]">Question {n} of 2</span>
          </div>
          <div className="mb-1 flex items-center gap-1.5 text-[11px] text-[#4b5563]">
            <span className="font-[family-name:monospace]">{code.path}</span>
            <span aria-hidden>·</span>
            <span>{code.lines.includes('–') ? `lines ${code.lines}` : `line ${code.lines}`}</span>
          </div>
          <Code lines={code.code} />
          <p className="mb-0 mt-2 text-[12.5px] leading-[1.5] text-[#1f2937]">{text}</p>
        </div>
      </div>
    </div>
  );
}

/** offer_next_step: the feedback, the lead-in, then Try Again / Next →. */
function Feedback({ text, active }: { text: string; active: boolean }) {
  return (
    <AssistantBubble>
      <p className="m-0">{text}</p>
      <p className="mb-0 mt-2">Ready for the next question?</p>
      <div className="mt-2 flex gap-2">
        <Button size="small" disabled={!active}>
          Try Again
        </Button>
        <span data-cursor={active ? 'next' : undefined}>
          <Button type="primary" size="small" disabled={!active}>
            Next →
          </Button>
        </span>
      </div>
    </AssistantBubble>
  );
}

/** ProgressDivider, in its own row with its own avatar. */
function Completed({ n, emoji, text }: { n: number; emoji: string; text: string }) {
  return (
    <div className="flex items-start gap-2">
      <AssistantAvatar />
      <div className="rounded-lg border border-[#d9d9d9] bg-white px-3 py-2 text-[12px] leading-[1.5]">
        <div className="text-[#374151]">
          completed question {n}: <span className="text-[14px]">{emoji}</span>
        </div>
        <div className="text-[#666]">{text}</div>
      </div>
    </div>
  );
}

/** QuizResults, from its top: the alert, the evaluation card, the score ring. */
function Results() {
  return (
    <div className="flex flex-col gap-2.5">
      <Alert
        message="Quiz Complete!"
        description="Your responses have been evaluated. Here are your results:"
        type="success"
        showIcon
      />
      <Card
        size="small"
        title={
          <span className="flex items-center gap-2">
            <TrophyOutlined style={{ fontSize: 18, color: '#52c41a' }} />
            Quiz Evaluation: GOOD
          </span>
        }
      >
        <div className="flex items-center gap-5">
          <Progress
            type="circle"
            size={84}
            percent={75}
            strokeColor="#1890ff"
            format={p => (
              <div>
                <div className="text-[18px] font-bold text-gray-900">{p}%</div>
                <div className="text-[11px] text-gray-500">Score</div>
              </div>
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-semibold text-gray-900">Summary</div>
            <p className="m-0 text-[12px] text-gray-700">
              Strong on why the hash map makes solve() linear. Collisions need another look.
            </p>
            <div className="mt-2 text-[12.5px] font-semibold text-gray-900">
              <CheckCircleOutlined style={{ color: '#52c41a', marginRight: 6 }} />
              Strengths
            </div>
            <p className="m-0 text-[12px] text-gray-700">Explains average O(1) lookups clearly.</p>
          </div>
        </div>
      </Card>
    </div>
  );
}

export function QuizDemo() {
  const demo = useDemoTimeline({ initial, steps, duration: 15600 });
  const { state: s } = demo;
  const awaiting = s.phase === 'q1' || s.phase === 'q2';

  return (
    <DemoFrame
      controller={demo}
      address="app.classmoji.io/student/cs52-26f/quizzes"
      label="Demo: a student takes a code review quiz. The tutor reads his repository, asks two questions about his own solve() code, gives feedback after each answer, and ends with a 75% score."
      rest={{ x: 0.6, y: 0.5 }}
    >
      <div className="relative h-full overflow-hidden">
        <AppShell active="quizzes" role="student" user={demoUsers.student} title="Quizzes">
          <div className="h-full rounded-2xl bg-panel ring-1 ring-line" />
        </AppShell>
        <div className="absolute inset-0 bg-black/45" aria-hidden />

        <Compact>
          <section
            aria-label="Code review quiz"
            className="absolute inset-y-0 right-0 flex w-[90%] flex-col bg-white shadow-[-6px_0_16px_0_rgba(0,0,0,0.08),-3px_0_6px_-4px_rgba(0,0,0,0.12),-9px_0_28px_8px_rgba(0,0,0,0.05)]"
          >
            <header className="flex h-11 shrink-0 items-center gap-3 border-b border-[#f0f0f0] bg-[#f9f9f9] px-4">
              <CloseOutlined style={{ fontSize: 13, color: 'rgba(0,0,0,0.45)' }} />
              <span className="text-[14px] font-semibold text-[rgba(0,0,0,0.88)]">
                <span className="mr-1.5 text-[16px]">🧑‍💻</span>
                {QUIZ}
              </span>
            </header>

            <div className="flex min-h-0 flex-1 flex-col px-5 pb-4 pt-3">
              <div className="flex min-h-0 flex-1 flex-col justify-end gap-3 overflow-hidden">
                {reached(s, 'welcome') && <AssistantBubble>{WELCOME}</AssistantBubble>}
                {reached(s, 'reading1') && (
                  <div className="pl-9">
                    <Steps files={s.files} open={s.phase === 'reading1'} />
                  </div>
                )}
                {reached(s, 'q1') && <Question n={1} code={CODE1} text={Q1} />}
                {reached(s, 'a1') && <UserBubble text={A1} />}
                {reached(s, 'feedback1') && (
                  <Feedback text={FEEDBACK1} active={s.phase === 'feedback1'} />
                )}
                {reached(s, 'next1') && <UserBubble text="next" />}
                {reached(s, 'q2') && (
                  <>
                    <Completed n={1} emoji="🚀" text="Clear grasp of why the lookup is O(1)." />
                    <div className="pl-9">
                      <Steps files={1} open={false} />
                    </div>
                    <Question n={2} code={CODE2} text={Q2} />
                  </>
                )}
                {reached(s, 'a2') && <UserBubble text={A2} />}
                {reached(s, 'feedback2') && (
                  <Feedback text={FEEDBACK2} active={s.phase === 'feedback2'} />
                )}
                {reached(s, 'done') && (
                  <>
                    <UserBubble text="next" />
                    <Completed n={2} emoji="🤔" text="Collisions are resolved, not overwritten." />
                    <Results />
                  </>
                )}
                {s.thinking && (
                  <div className="flex items-start gap-2">
                    <AssistantAvatar />
                    <div className="flex items-center gap-2 rounded-lg border border-[#d9d9d9] bg-white px-3 py-2">
                      <span className="flex gap-1">
                        {[0, 1, 2].map(d => (
                          <span
                            key={d}
                            className="demo-typing-dot h-1.5 w-1.5 rounded-full bg-[#10b981]"
                            style={{ animationDelay: `${d * 160}ms` }}
                          />
                        ))}
                      </span>
                      <span className="text-[12px] text-[rgba(0,0,0,0.45)]">{s.thinking}</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-3 shrink-0 border-t border-[#f0f0f0] pt-3">
                <div
                  className={`overflow-hidden rounded-lg border border-[#e5e7eb] ${s.phase === 'done' ? 'opacity-50' : ''}`}
                >
                  <div className="flex items-center gap-2 border-b border-[#e5e7eb] bg-gray-50 px-2 py-1">
                    <Select
                      size="small"
                      value="javascript"
                      style={{ width: 110 }}
                      open={false}
                      options={[{ value: 'javascript', label: 'JavaScript' }]}
                    />
                    <Button
                      size="small"
                      icon={<CodeOutlined />}
                      style={{ backgroundColor: '#fadb14', borderColor: '#fadb14', color: '#000' }}
                    >
                      Insert Code
                    </Button>
                    <span className="ml-auto text-[11px] text-gray-500">
                      Click Send to submit your message
                    </span>
                  </div>
                  <div
                    data-cursor="composer"
                    className="min-h-[38px] px-3 py-2 text-[12px] leading-[1.5]"
                  >
                    {s.draft ? (
                      <span className="text-gray-900">{s.draft}</span>
                    ) : (
                      <span className="text-gray-400">
                        {s.phase === 'done'
                          ? 'Quiz completed!'
                          : 'Type your response... (use Code button to add code snippets)'}
                      </span>
                    )}
                  </div>
                  <div className="flex justify-end border-t border-[#e5e7eb] px-2 py-1">
                    <span data-cursor="send">
                      <Button
                        size="small"
                        icon={<SendOutlined />}
                        disabled={!(awaiting && s.draft)}
                        style={
                          awaiting && s.draft
                            ? { backgroundColor: '#fadb14', borderColor: '#fadb14', color: '#000' }
                            : undefined
                        }
                      >
                        Send
                      </Button>
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </Compact>
      </div>
    </DemoFrame>
  );
}
