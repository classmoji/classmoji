import { canDropOriginal, warnsWithoutOptimising, type VideoOptions } from './videoOptions.ts';

/**
 * The three video choices an upload dialog shows (media plan §3.10).
 *
 * Render it for a VIDEO only — the caller decides that, with `kindOfFilename`
 * from `@classmoji/services/media/router`, so there is one list of video
 * extensions and it is the server's. A pdf or an mp3 has nothing to choose and
 * should get no options area at all.
 *
 * Styled by its own stylesheet (`styles.css`, imported by this module's index)
 * rather than by Tailwind classes, because a consuming app's Tailwind does not
 * scan this package: the pages app, the webapp and slides each get the same
 * look, in light and dark, with or without the shared design tokens loaded.
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
  <label htmlFor={id} className={`cm-media-option${disabled ? ' cm-media-option--disabled' : ''}`}>
    <input
      id={id}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={event => onChange(event.target.checked)}
      className="cm-media-option__input"
    />
    <span className="cm-media-option__text">
      <span className="cm-media-option__label">{label}</span>
      <span className="cm-media-option__help">{help}</span>
    </span>
  </label>
);

export interface MediaVideoOptionsProps {
  /** The chosen file's name — only its extension is read, for the `.mov` warning. */
  filename: string;
  value: VideoOptions;
  /** One toggle; fold it in with `applyVideoOption` so the locked pair stays in step. */
  onChange: (field: keyof VideoOptions, next: boolean) => void;
  /** Locks every box, e.g. while the upload is running. */
  disabled?: boolean;
  /** Prefix for the checkbox ids, for a page that shows two of these at once. */
  idPrefix?: string;
}

export const MediaVideoOptions = ({
  filename,
  value,
  onChange,
  disabled,
  idPrefix = 'media',
}: MediaVideoOptionsProps) => {
  const originalLocked = !canDropOriginal(value);

  return (
    <div className="cm-media-options">
      <OptionRow
        id={`${idPrefix}-optimise`}
        label="Optimise for streaming"
        help="Converts it to a format that plays in every browser."
        checked={value.optimise}
        disabled={disabled}
        onChange={next => onChange('optimise', next)}
      />

      {warnsWithoutOptimising(filename, value) && (
        <p className="cm-media-options__warning">
          May not play in Firefox or on Windows without optimising.
        </p>
      )}

      <OptionRow
        id={`${idPrefix}-keep-original`}
        label="Keep the original"
        // Ticked and locked when there is no optimised copy to keep it beside.
        help={
          originalLocked
            ? 'Without optimising, the file you uploaded is the only copy.'
            : 'Also store the file you uploaded. Only the original counts toward storage.'
        }
        checked={value.keepOriginal}
        disabled={disabled || originalLocked}
        onChange={next => onChange('keepOriginal', next)}
      />

      <OptionRow
        id={`${idPrefix}-allow-download`}
        label="Allow download"
        help="Show students a download button."
        checked={value.allowDownload}
        disabled={disabled}
        onChange={next => onChange('allowDownload', next)}
      />
    </div>
  );
};

export default MediaVideoOptions;
