import { canDropOriginal, warnsWithoutOptimising, type VideoOptions } from '~/utils/mediaUpload';

/**
 * The three video choices (plan §3.10). Set here or nowhere: processing runs
 * once, right after the upload, and nobody can change them afterwards — so each
 * box says what it does. The same three, with the same defaults and the same
 * rule for "Keep the original", as the webapp's Media page.
 */

interface OptionRowProps {
  id: string;
  label: string;
  help: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

const OptionRow = ({ id, label, help, checked, disabled, onChange }: OptionRowProps) => (
  <label
    htmlFor={id}
    className={`flex gap-3 rounded-xl border border-[var(--line)] px-3 py-2.5 transition-colors ${
      disabled ? 'cursor-default opacity-70' : 'cursor-pointer hover:bg-[var(--panel-tint)]'
    }`}
  >
    <input
      id={id}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={event => onChange(event.target.checked)}
      className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
    />
    <span className="min-w-0">
      <span className="block text-sm font-semibold text-[var(--ink-0)]">{label}</span>
      <span className="block text-xs text-[var(--ink-3)]">{help}</span>
    </span>
  </label>
);

export function VideoOptionsFields({
  filename,
  value,
  onChange,
  disabled,
}: {
  filename: string;
  value: VideoOptions;
  onChange: (field: keyof VideoOptions, next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <OptionRow
        id="slides-media-optimise"
        label="Optimise for streaming"
        help="Converts it to a format that plays in every browser."
        checked={value.optimise}
        disabled={disabled}
        onChange={next => onChange('optimise', next)}
      />

      {warnsWithoutOptimising(filename, value) && (
        <p className="rounded-xl border border-[var(--amber-bord)] bg-[var(--amber-bg)] px-3 py-2 text-xs text-[var(--amber-ink)]">
          May not play in Firefox or on Windows without optimising.
        </p>
      )}

      <OptionRow
        id="slides-media-keep-original"
        label="Keep the original"
        help="Store the file you uploaded alongside the optimised copy. Only the original counts towards your storage."
        checked={value.keepOriginal}
        disabled={disabled || !canDropOriginal(value)}
        onChange={next => onChange('keepOriginal', next)}
      />

      <OptionRow
        id="slides-media-allow-download"
        label="Allow download"
        help="Show students a download button."
        checked={value.allowDownload}
        disabled={disabled}
        onChange={next => onChange('allowDownload', next)}
      />
    </div>
  );
}

export default VideoOptionsFields;
