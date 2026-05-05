import { Button } from '../Button/Button.tsx';
import { IconButton } from '../IconButton/IconButton.tsx';
import { IconX } from '../icons/index.tsx';
import type { ActiveCallout } from './types.ts';
import { VARIANT_CONFIG } from './variants.tsx';

export interface CalloutCardProps {
  payload: ActiveCallout;
  onDismiss: () => void;
}

export function CalloutCard({ payload, onDismiss }: CalloutCardProps) {
  const { variant, title, message, icon, action, progress } = payload;
  const config = VARIANT_CONFIG[variant];

  const isAlert = variant === 'error';
  const role = isAlert ? 'alert' : 'status';
  const ariaLive: 'assertive' | 'polite' = isAlert ? 'assertive' : 'polite';

  const showProgressBar = variant === 'progress' && progress != null;
  const progressPct = showProgressBar
    ? Math.max(0, Math.min(1, progress)) * 100
    : 0;

  return (
    <div
      role={role}
      aria-live={ariaLive}
      className="relative flex items-center gap-3 rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 px-4 py-3 shadow-sm overflow-hidden"
    >
      {/* Left accent bar */}
      <div
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-1 ${config.accentClassName}`}
      />

      {/* Icon */}
      <div
        className={`flex-shrink-0 flex items-center justify-center w-6 h-6 ${config.iconColorClassName}`}
      >
        {icon ?? config.defaultIcon}
      </div>

      {/* Text block */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-col sm:flex-row sm:items-baseline sm:gap-1.5">
          <span className="font-semibold text-gray-900 dark:text-gray-100">
            {title}
          </span>
          {message ? (
            <span className="text-gray-600 dark:text-gray-400">{message}</span>
          ) : null}
        </div>
      </div>

      {/* Optional action */}
      {action ? (
        <Button
          variant="ghost"
          onClick={action.onClick}
          className="flex-shrink-0"
        >
          {action.label}
        </Button>
      ) : null}

      {/* Dismiss */}
      <IconButton
        label="Dismiss"
        icon={<IconX size={16} />}
        onClick={onDismiss}
        className="flex-shrink-0"
      />

      {/* Progress bar */}
      {showProgressBar ? (
        <div
          aria-hidden="true"
          className="absolute bottom-0 left-0 h-0.5 bg-violet-500"
          style={{
            width: `${progressPct}%`,
            transition: 'width 240ms ease-out',
          }}
        />
      ) : null}
    </div>
  );
}
