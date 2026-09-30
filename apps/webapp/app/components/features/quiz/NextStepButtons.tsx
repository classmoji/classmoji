import { Button } from 'antd';
import { BUTTON_TEXT, type NextStepAction } from '@classmoji/utils/quiz-agent';

/**
 * The Try again / Next buttons the quiz agent offers after its feedback on an
 * answer (the `offer_next_step` tool part). A click sends the button's fixed
 * text as the student's next message, exactly the text the legacy buttons sent,
 * so the server can tag it. The buttons are shown in a fixed order whatever
 * order the tool listed them in.
 */
interface NextStepButtonsProps {
  actions: readonly NextStepAction[];
  /** Nothing can be sent: a later message exists, a turn is running, or the view is read-only. */
  disabled?: boolean;
  /** Absent in read-only views: the buttons render disabled. */
  onAction?: ((text: string, action: NextStepAction) => void) | null;
}

function NextStepButtons({ actions, disabled = false, onAction = null }: NextStepButtonsProps) {
  const canAct = !disabled && typeof onAction === 'function';
  const has = (action: NextStepAction) => actions.includes(action);
  if (!has('try_again') && !has('next')) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-2" data-testid="quiz-next-step">
      {has('try_again') && (
        <Button
          size="small"
          data-testid="quiz-try-again"
          disabled={!canAct}
          onClick={canAct ? () => onAction!(BUTTON_TEXT.try_again, 'try_again') : undefined}
        >
          Try Again
        </Button>
      )}
      {has('next') && (
        <Button
          type="primary"
          size="small"
          data-testid="quiz-next"
          disabled={!canAct}
          onClick={canAct ? () => onAction!(BUTTON_TEXT.next, 'next') : undefined}
        >
          Next →
        </Button>
      )}
    </div>
  );
}

export default NextStepButtons;
