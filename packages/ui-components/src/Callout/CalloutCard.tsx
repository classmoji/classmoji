import { Button } from '../Button/Button.tsx';
import { IconX } from '../icons/index.tsx';
import type { ActiveCallout } from './types.ts';
import { VARIANT_CONFIG } from './variants.tsx';

export interface CalloutCardProps {
  payload: ActiveCallout;
  onDismiss: () => void;
}

/**
 * One notification. Styled through `.cm-callout*` in the shared
 * `styles/components.css` rather than with utility classes, because no app puts
 * this package's source in its Tailwind scan path: a utility that no app file
 * happens to use is never emitted, and that is every value this design asks
 * for (an 11px gap, a 13.5px title, a 5px bar).
 *
 * Progress reads as a job — the count under the title, a bar across the body.
 * Everything else reads as a sentence, on one line.
 */
export function CalloutCard({ payload, onDismiss }: CalloutCardProps) {
  const { variant, title, message, icon, action, progress } = payload;
  const config = VARIANT_CONFIG[variant];

  const isAlert = variant === 'error';
  const role = isAlert ? 'alert' : 'status';
  const ariaLive: 'assertive' | 'polite' = isAlert ? 'assertive' : 'polite';

  const isProgress = variant === 'progress';
  const showProgressBar = isProgress && progress != null;
  const progressPct = showProgressBar ? Math.max(0, Math.min(1, progress)) * 100 : 0;

  return (
    <div role={role} aria-live={ariaLive} className="cm-callout">
      <span className={`cm-callout-icon ${config.toneClassName}`}>
        {icon ?? config.defaultIcon}
      </span>

      <div className="cm-callout-body">
        {isProgress ? (
          <>
            <div className="cm-callout-title">{title}</div>
            {message ? <div className="cm-callout-meta">{message}</div> : null}
            {showProgressBar ? (
              <div aria-hidden="true" className="cm-callout-track">
                <div className="cm-callout-fill" style={{ width: `${progressPct}%` }} />
              </div>
            ) : null}
          </>
        ) : (
          <div className="cm-callout-line">
            <span className="cm-callout-title">{title}</span>
            {message ? <span className="cm-callout-meta">{message}</span> : null}
          </div>
        )}
      </div>

      {action ? (
        <Button className="btn-sm" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}

      <button
        type="button"
        className="cm-callout-close"
        title="Dismiss"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <IconX size={13} />
      </button>
    </div>
  );
}
