import {
  canDropOriginal,
  isVideoFilename,
  warnsWithoutOptimising,
  type VideoOptions,
} from './mediaUploadOptions';

/**
 * The three video choices, and only for video.
 *
 * They are set here or nowhere: processing runs once, right after the upload,
 * and there is no per-video control on the media page afterwards for anyone.
 * So each box carries a line saying what it will do, rather than leaving an
 * instructor to guess which one costs them storage.
 *
 * A pdf, a zip or an mp3 has nothing to decide, and this renders nothing at all
 * for them — an empty options area would only invite a search for the settings
 * that are not there.
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
    className={`flex gap-3 rounded-xl px-3 py-2.5 ring-1 ring-line transition-colors ${
      disabled ? 'cursor-default opacity-70' : 'cursor-pointer hover:bg-nav-hover'
    }`}
  >
    <input
      id={id}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={event => onChange(event.target.checked)}
      className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
    />
    <span className="min-w-0">
      <span className="block text-sm font-semibold text-ink-0">{label}</span>
      <span className="block text-xs text-ink-3">{help}</span>
    </span>
  </label>
);

interface MediaVideoOptionsProps {
  filename: string;
  value: VideoOptions;
  onChange: (field: keyof VideoOptions, next: boolean) => void;
  disabled?: boolean;
}

export const MediaVideoOptions = ({
  filename,
  value,
  onChange,
  disabled,
}: MediaVideoOptionsProps) => {
  if (!isVideoFilename(filename)) return null;

  return (
    <div className="flex flex-col gap-2">
      <OptionRow
        id="media-optimise"
        label="Optimise for streaming"
        help="Re-encode in the background so it starts playing straight away and works in every browser."
        checked={value.optimise}
        disabled={disabled}
        onChange={next => onChange('optimise', next)}
      />

      {warnsWithoutOptimising(filename, value) && (
        <p className="rounded-xl bg-amber-bg px-3 py-2 text-xs text-amber-ink ring-1 ring-amber-bord">
          May not play in Firefox or on Windows without optimising.
        </p>
      )}

      <OptionRow
        id="media-keep-original"
        label="Keep the original"
        // Ticked and locked when there is no optimised copy to keep it beside.
        help="Store the file you uploaded alongside the optimised copy. Only the original counts towards your storage."
        checked={value.keepOriginal}
        disabled={disabled || !canDropOriginal(value)}
        onChange={next => onChange('keepOriginal', next)}
      />

      <OptionRow
        id="media-allow-download"
        label="Allow download"
        help="Give students a download button. Teaching staff can always download from this page."
        checked={value.allowDownload}
        disabled={disabled}
        onChange={next => onChange('allowDownload', next)}
      />
    </div>
  );
};

export default MediaVideoOptions;
