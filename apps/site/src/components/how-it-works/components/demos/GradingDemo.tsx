import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { SmilePlusIcon } from 'lucide-react';
import { demoUsers } from '../../data/appNav';
import { useDemoTimeline } from '../../hooks/useDemoTimeline';
import type { DemoBase, Step } from '../../types/demo';
import { button, chip, segmentItem, ui } from '../../utils/classes';
import { average, letterGrade } from '../../utils/grades';
import { EASE_OUT, clickAnd, moveTo } from '../../utils/timeline';
import { AnimatedNumber } from '../demo-kit/AnimatedNumber';
import { AppShell } from '../demo-kit/AppShell';
import { Avatar } from '../demo-kit/Avatar';
import { DemoFrame } from '../demo-kit/DemoFrame';

type Reaction = { emoji: string; by: string };

type State = DemoBase & {
  reactions: Reaction[];
  pickerOpen: boolean;
  numeric: boolean;
  flash: boolean;
};

const PICKER = [
  { id: 'star', emoji: '🌟', value: 96 },
  { id: 'fire', emoji: '🔥', value: 88 },
  { id: 'thumbs', emoji: '👍', value: 80 },
  { id: 'think', emoji: '🤔', value: 70 },
];

const VALUE: Record<string, number> = Object.fromEntries(PICKER.map((p) => [p.emoji, p.value]));

const GRADEBOOK: { name: string; initials: string; cells: string[][]; live?: boolean }[] = [
  { name: 'Alice Wong', initials: 'AW', cells: [['🌟', '🌟'], ['🔥', '🌟'], ['🔥', '👍']] },
  { name: 'Bob Kim', initials: 'BK', cells: [['🔥', '🔥'], ['🌟', '👍']], live: true },
  { name: 'Chen Li', initials: 'CL', cells: [['👍', '🔥'], ['🤔', '👍'], ['🌟', '🔥']] },
  { name: 'Dana Ortiz', initials: 'DO', cells: [['🌟', '🔥'], ['🔥', '🔥'], ['👍', '👍']] },
];

const initial: State = {
  cursor: null,
  click: 0,
  reactions: [
    { emoji: '🌟', by: 'Sam' },
    { emoji: '🔥', by: 'Priya' },
  ],
  pickerOpen: false,
  numeric: false,
  flash: false,
};

const addReaction =
  (emoji: string) =>
  (s: State): State => ({
    ...s,
    reactions: [...s.reactions, { emoji, by: 'You' }],
    pickerOpen: false,
    flash: true,
  });

const openPicker = (s: State): State => ({ ...s, pickerOpen: true });
const clearFlash = (s: State): State => ({ ...s, flash: false });

const steps: Step<State>[] = [
  { at: 600, action: moveTo<State>('add') },
  { at: 1250, action: clickAnd<State>(openPicker) },
  { at: 1800, action: moveTo<State>('emoji-fire') },
  { at: 2400, action: clickAnd<State>(addReaction('🔥')) },
  { at: 3300, action: clearFlash },
  { at: 3400, action: moveTo<State>('add') },
  { at: 4000, action: clickAnd<State>(openPicker) },
  { at: 4500, action: moveTo<State>('emoji-thumbs') },
  { at: 5100, action: clickAnd<State>(addReaction('👍')) },
  { at: 6000, action: clearFlash },
  { at: 6200, action: moveTo<State>('toggle') },
  { at: 6800, action: clickAnd<State>((s) => ({ ...s, numeric: true })) },
  { at: 8400, action: clickAnd<State>((s) => ({ ...s, numeric: false })) },
  { at: 9000, action: moveTo<State>(null) },
];

const cellScore = (emojis: string[]) => average(emojis.map((e) => VALUE[e]));

export function GradingDemo() {
  const demo = useDemoTimeline({ initial, steps, duration: 9800 });
  const { state: s, act, sequence } = demo;

  const score = cellScore(s.reactions.map((r) => r.emoji));
  const letter = letterGrade(score);

  const togglePicker = () => act((st) => ({ ...st, pickerOpen: !st.pickerOpen }));
  const pick = (emoji: string) => {
    if (s.reactions.length >= 6) {
      act((st) => ({ ...st, pickerOpen: false }));
      return;
    }
    sequence([
      { at: 0, action: addReaction(emoji) },
      { at: 900, action: clearFlash },
    ]);
  };
  const removeReaction = (index: number) =>
    act((st) => ({ ...st, reactions: st.reactions.filter((_, i) => i !== index) }));
  const toggleScale = () => act((st) => ({ ...st, numeric: !st.numeric }));

  const scaleToggle = (
    <button
      type="button"
      role="switch"
      aria-checked={s.numeric}
      aria-label="Show numeric scores"
      data-cursor="toggle"
      onClick={toggleScale}
      className={`${ui.segment} ${ui.focus}`}
    >
      {(['Emoji', '0–100'] as const).map((label, i) => (
        <span key={label} className={segmentItem((i === 1) === s.numeric)}>
          {label}
        </span>
      ))}
    </button>
  );

  return (
    <DemoFrame
      controller={demo}
      address="classmoji.app/cs52-26f/grades"
      label="Demo: a TA adds fire and thumbs-up reactions to Bob's submission; his average drops from 92 to 88 and his letter grade changes from A- to B+."
      rest={{ x: 0.9, y: 0.45 }}
    >
      <AppShell active="grades" role="staff" user={demoUsers.ta} title="Grades" actions={scaleToggle}>
        <section className={`flex h-full flex-col p-5 ${ui.card}`}>
          <div className="relative z-10">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <Avatar initials="BK" />
                <div>
                  <p className="text-[14px] font-semibold">Bob Kim · HW3: Hash Maps</p>
                  <p className={`text-[12px] ${ui.ink3}`}>bob-hw3 · Submitted Thu 9:42pm</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className="text-[26px] font-bold leading-none tracking-tight">
                    <AnimatedNumber value={score} />
                  </div>
                  <div className={`mt-1 text-[11px] ${ui.ink3}`}>avg of {s.reactions.length}</div>
                </div>
                <div
                  className="relative grid h-9 w-11 place-items-center overflow-hidden rounded-md border border-line-2 text-[14px] font-bold dark:border-line-2-dark"
                  aria-label={`Letter grade ${letter}`}
                >
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span
                      key={letter}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.22, ease: EASE_OUT }}
                    >
                      {letter}
                    </motion.span>
                  </AnimatePresence>
                </div>
              </div>
            </div>

            <div className="mt-4 flex items-center gap-1.5">
              <AnimatePresence initial={false}>
                {s.reactions.map((r, i) => {
                  const mine = r.by === 'You';
                  return (
                    <motion.button
                      key={`${r.emoji}-${r.by}-${i}`}
                      type="button"
                      layout
                      initial={{ opacity: 0, scale: 0.96 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.96 }}
                      transition={{ duration: 0.2, ease: EASE_OUT }}
                      onClick={() => mine && removeReaction(i)}
                      aria-label={`${r.emoji} by ${r.by}${mine ? ', click to remove' : ''}`}
                      className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] font-medium ${
                        mine
                          ? `border-accent/30 ${ui.selected} ${ui.selectedInk}`
                          : `cursor-default border-line-2 bg-panel dark:border-line-2-dark dark:bg-panel-dark ${ui.ink2}`
                      } ${ui.focus}`}
                    >
                      <span className="text-[14px] leading-none">{r.emoji}</span>
                      {r.by}
                    </motion.button>
                  );
                })}
              </AnimatePresence>
              <div className="relative">
                <button
                  type="button"
                  data-cursor="add"
                  onClick={togglePicker}
                  aria-label="Add reaction"
                  aria-expanded={s.pickerOpen}
                  className={`${button('default', 'sm')} !h-7 !w-7 !px-0`}
                >
                  <SmilePlusIcon className="h-3.5 w-3.5" aria-hidden />
                </button>
                <AnimatePresence>
                  {s.pickerOpen && (
                    <motion.div
                      role="menu"
                      initial={{ opacity: 0, scale: 0.96, y: -4 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.96, y: -4 }}
                      transition={{ duration: 0.16, ease: EASE_OUT }}
                      style={{ originX: 0, originY: 0 }}
                      className={`absolute left-0 top-full z-20 mt-2 flex gap-1 p-1.5 ${ui.floating}`}
                    >
                      {PICKER.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          role="menuitem"
                          data-cursor={`emoji-${p.id}`}
                          onClick={() => pick(p.emoji)}
                          className={`flex w-12 flex-col items-center gap-0.5 rounded-md py-1.5 ${ui.rowHover} ${ui.focus}`}
                        >
                          <span className="text-[18px] leading-none">{p.emoji}</span>
                          <span className={`text-[10.5px] tabular-nums ${ui.ink3}`}>{p.value}</span>
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>

          <div className={`mt-5 border-t pt-4 ${ui.divider}`}>
            <h5 className="text-[14px] font-semibold">Gradebook</h5>
            <table className="mt-2 w-full text-[13px]">
              <thead>
                <tr className={`border-b text-left ${ui.divider} ${ui.tableHead}`}>
                  <th scope="col" className="py-2 font-semibold">
                    Student
                  </th>
                  {['HW1', 'HW2', 'HW3'].map((h) => (
                    <th key={h} scope="col" className="w-[96px] px-2 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {GRADEBOOK.map((row) => {
                  const cells = row.live ? [...row.cells, s.reactions.map((r) => r.emoji)] : row.cells;
                  return (
                    <tr key={row.name} className={`border-b ${ui.divider} ${row.live ? ui.selected : ui.rowHover}`}>
                      <th scope="row" className="py-2 pl-1 text-left font-medium">
                        <span className="flex items-center gap-2">
                          <Avatar initials={row.initials} size="sm" />
                          {row.name}
                        </span>
                      </th>
                      {cells.map((emojis, ci) => {
                        const live = row.live && ci === 2;
                        const value = s.numeric ? String(cellScore(emojis)) : emojis.join('');
                        return (
                          <td key={ci} className="relative px-2 py-2">
                            {live && (
                              <motion.span
                                aria-hidden
                                className="absolute inset-x-0.5 inset-y-1 rounded-md bg-panel ring-1 ring-accent/50 dark:bg-panel-dark"
                                initial={false}
                                animate={{ opacity: s.flash ? 1 : 0 }}
                                transition={{ duration: 0.2, ease: EASE_OUT }}
                              />
                            )}
                            <AnimatePresence mode="popLayout" initial={false}>
                              <motion.span
                                key={value}
                                initial={{ opacity: 0, y: 4 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -4 }}
                                transition={{ duration: 0.18, ease: EASE_OUT }}
                                className={`relative block px-1.5 ${
                                  s.numeric ? 'font-semibold tabular-nums' : 'text-[13px] tracking-[0.06em]'
                                }`}
                              >
                                {value}
                              </motion.span>
                            </AnimatePresence>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </AppShell>
    </DemoFrame>
  );
}
