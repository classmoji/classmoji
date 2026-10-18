import { memo, useState } from 'react';
import {
  IconBook,
  IconChevronDown,
  IconChevronRight,
  IconCircleCheck,
  IconFileText,
  IconHelp,
  IconLoader2,
  IconThumbDown,
  IconThumbUp,
} from '@tabler/icons-react';
import type { AskMojiUIMessage } from '@classmoji/utils/ask-moji';
import AskMojiMarkdown, { CopyButton } from './AskMojiMarkdown';
import { textOf } from './machine';
import { sourceChipsOf, stepsOf, type SourceChip } from './parts';
import type { AskMojiRating } from './api';

export interface ChipContext {
  classroomSlug: string;
  pagesUrl: string | null;
  slidesUrl: string | null;
}

const chipIcon = (type: SourceChip['type']) =>
  type === 'page' ? (
    <IconFileText size={13} aria-hidden="true" />
  ) : type === 'slides' ? (
    <IconBook size={13} aria-hidden="true" />
  ) : (
    <IconHelp size={13} aria-hidden="true" />
  );

/** A chip with no link is a label: no href, not focusable. */
export function SourceChips({ chips }: { chips: SourceChip[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="moji-refs">
      {chips.map(chip =>
        chip.url ? (
          <a
            key={chip.key}
            href={chip.url}
            target="_blank"
            rel="noopener noreferrer"
            className="moji-ref"
          >
            {chipIcon(chip.type)}
            <span>{chip.title}</span>
          </a>
        ) : (
          <span key={chip.key} className="moji-ref">
            {chipIcon(chip.type)}
            <span>{chip.title}</span>
          </span>
        )
      )}
    </div>
  );
}

const lookedAt = (n: number) => `Looked at ${n} ${n === 1 ? 'thing' : 'things'}`;

function Steps({ message, live }: { message: AskMojiUIMessage; live: boolean }) {
  const steps = stepsOf(message);
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  if (live) {
    return (
      <ul className="moji-steps">
        {steps.map(step => (
          <li key={step.id} className="moji-step" data-done={step.done ? '' : undefined}>
            {step.done ? (
              <IconCircleCheck size={13} aria-hidden="true" />
            ) : (
              <IconLoader2 size={13} className="moji-spin" aria-hidden="true" />
            )}
            <span>{step.title}</span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="moji-steps-folded">
      <button
        type="button"
        className="moji-steps-toggle"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        {lookedAt(steps.length)}
      </button>
      {open && (
        <ul className="moji-steps">
          {steps.map(step => (
            <li key={step.id} className="moji-step" data-done="">
              <IconCircleCheck size={13} aria-hidden="true" />
              <span>{step.title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface AnswerProps {
  message: AskMojiUIMessage;
  /** This answer is still streaming. */
  live: boolean;
  rating: AskMojiRating | null;
  onRate: (id: string, rating: AskMojiRating | null) => void;
  chips: ChipContext;
}

function AnswerView({ message, live, rating, onRate, chips }: AnswerProps) {
  const text = textOf(message);
  const sources = live ? [] : sourceChipsOf(message, chips);
  const toggle = (value: AskMojiRating) => onRate(message.id, rating === value ? null : value);
  // A reply that carried nothing to show (only a notice, which shows as the panel's line).
  if (!live && !text && sources.length === 0 && stepsOf(message).length === 0) return null;
  return (
    <div className="moji-msg moji-msg--moji">
      <Steps message={message} live={live} />
      {text && (
        <div className="moji-answer">
          <AskMojiMarkdown text={text} />
        </div>
      )}
      <SourceChips chips={sources} />
      {!live && text && (
        <div className="moji-actions">
          <CopyButton text={text} label="Copy answer" className="moji-action" />
          <button
            type="button"
            className="moji-action"
            aria-pressed={rating === 'UP'}
            aria-label="Helpful"
            title="Helpful"
            onClick={() => toggle('UP')}
          >
            <IconThumbUp size={13} />
          </button>
          <button
            type="button"
            className="moji-action"
            aria-pressed={rating === 'DOWN'}
            aria-label="Not helpful"
            title="Not helpful"
            onClick={() => toggle('DOWN')}
          >
            <IconThumbDown size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

function QuestionView({ message }: { message: AskMojiUIMessage }) {
  return (
    <div className="moji-msg moji-msg--user">
      <span className="moji-chevron" aria-hidden="true">
        &#x276F;
      </span>
      <span className="moji-user-text">{textOf(message)}</span>
    </div>
  );
}

function AskMojiMessageView(props: {
  message: AskMojiUIMessage;
  live: boolean;
  rating: AskMojiRating | null;
  onRate: (id: string, rating: AskMojiRating | null) => void;
  chips: ChipContext;
}) {
  if (props.message.role === 'user') return <QuestionView message={props.message} />;
  if (props.message.role !== 'assistant') return null;
  return <AnswerView {...props} />;
}

export default memo(AskMojiMessageView);
