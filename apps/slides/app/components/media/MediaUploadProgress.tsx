import { formatSize } from '~/utils/mediaUpload';

/**
 * An upload in flight: the file, how much of it has arrived, and a way to stop.
 *
 * Real progress, not a spinner — the bytes go straight from the browser to
 * storage in parts, and each finished part is counted, so the bar moves as the
 * upload does. On design-system tokens, so both themes come free.
 */
export function MediaUploadProgress({
  file,
  sentBytes,
  onCancel,
}: {
  file: { name: string; size: number };
  sentBytes: number;
  onCancel?: () => void;
}) {
  const percent = file.size > 0 ? Math.min(100, Math.round((sentBytes / file.size) * 100)) : 0;

  return (
    <div
      aria-live="polite"
      className="mt-3 rounded-[10px] border border-[var(--line)] bg-[var(--panel-tint)] px-4 py-3"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 break-all text-sm font-medium text-[var(--ink-0)]">
          {file.name} · {formatSize(file.size)}
        </p>
        <span className="shrink-0 text-xs tabular-nums text-[var(--ink-3)]">{percent}%</span>
      </div>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={`Uploading ${file.name}`}
        className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-[var(--line)]"
      >
        <div
          className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-xs leading-relaxed text-[var(--ink-3)]">Keep this tab open.</p>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="text-xs font-medium text-[var(--ink-2)] hover:text-[var(--ink-0)]"
          >
            Cancel upload
          </button>
        )}
      </div>
    </div>
  );
}

export default MediaUploadProgress;
