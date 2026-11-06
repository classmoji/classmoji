import { Button, Tooltip } from 'antd';
import {
  BUTTON_TEXT,
  HINT_COST,
  hintCostTooltip,
  type NextStepAction,
} from '@classmoji/utils/quiz-agent';

/**
 * The hint / move-on buttons the quiz agent offers after its feedback on an
 * answer (the `offer_next_step` tool part). A click sends the button's fixed
 * text as the student's next message (`BUTTON_TEXT`), so the server can tag
 * it. The buttons are shown in a fixed order whatever order the tool listed
 * them in. The tool's `lead_in` line is shown above them; without one, only
 * the buttons. A hint (the reply to a hint click) ends with the move-on
 * button alone and no line (QuizChat, `buttonSetsOf`): it sends the same text.
 *
 * Labels, by the question's state:
 * - "Try again with hint", with the hint's cost on hover (`hintCostTooltip`;
 *   a part saved before the server sent the cost reads `HINT_COST`).
 * - The move-on button while the question is still open (the offer has the
 *   hint button too, or it follows a hint): "Skip to next question", or
 *   "Skip to results" on the last question, not the primary button.
 * - Once the question is finished (an offer of Next alone): "Next question →",
 *   or "See results →" on the last question, the primary button.
 */
interface NextStepButtonsProps {
  actions: readonly NextStepAction[];
  /**
   * Not usable: a click, a newer set, a card, a result or the evaluation came
   * after this set, a turn is running, or the view is read-only.
   */
  disabled?: boolean;
  /** Absent in read-only views: the buttons render disabled. */
  onAction?: ((text: string, action: NextStepAction) => void) | null;
  /** The line shown above the buttons, from the tool's output. */
  leadIn?: string | null;
  /** Points a hint costs on this question (the offer's `hint_cost`); absent: `HINT_COST`. */
  hintCost?: number | null;
  /** The question these buttons follow is the quiz's last. */
  lastQuestion?: boolean;
  /**
   * The question is still open, so moving on skips it. Absent: open when the
   * set has the hint button.
   */
  open?: boolean;
}

/** The move-on button's label: skipping an open question, or moving on from a finished one. */
export const moveOnLabel = ({ open, lastQuestion }: { open: boolean; lastQuestion: boolean }) =>
  open
    ? lastQuestion
      ? 'Skip to results'
      : 'Skip to next question'
    : lastQuestion
      ? 'See results →'
      : 'Next question →';

export const HINT_BUTTON_LABEL = 'Try again with hint';

function NextStepButtons({
  actions,
  disabled = false,
  onAction = null,
  leadIn = null,
  hintCost = null,
  lastQuestion = false,
  open,
}: NextStepButtonsProps) {
  const canAct = !disabled && typeof onAction === 'function';
  const has = (action: NextStepAction) => actions.includes(action);
  if (!has('try_again') && !has('next')) return null;
  const line = leadIn?.trim();
  const questionOpen = open ?? has('try_again');
  const cost = typeof hintCost === 'number' ? hintCost : HINT_COST;

  return (
    <>
      {line ? (
        <p className="my-2 leading-relaxed" data-testid="quiz-next-step-lead-in">
          {line}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2" data-testid="quiz-next-step">
        {has('try_again') && (
          <Tooltip title={hintCostTooltip(cost)}>
            <Button
              size="small"
              data-testid="quiz-try-again"
              disabled={!canAct}
              onClick={canAct ? () => onAction!(BUTTON_TEXT.try_again, 'try_again') : undefined}
            >
              {HINT_BUTTON_LABEL}
            </Button>
          </Tooltip>
        )}
        {has('next') && (
          <Button
            type={questionOpen ? 'default' : 'primary'}
            size="small"
            data-testid="quiz-next"
            disabled={!canAct}
            onClick={canAct ? () => onAction!(BUTTON_TEXT.next, 'next') : undefined}
          >
            {moveOnLabel({ open: questionOpen, lastQuestion })}
          </Button>
        )}
      </div>
    </>
  );
}

export default NextStepButtons;
