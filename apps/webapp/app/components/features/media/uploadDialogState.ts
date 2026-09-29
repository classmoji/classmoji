import {
  DEFAULT_VIDEO_OPTIONS,
  applyVideoOption,
  type VideoOptions,
} from '@classmoji/ui-components/media-options';

/**
 * The upload dialog's state, as a reducer so every transition can be asserted
 * without mounting antd.
 *
 * Two things this has to get right that a handful of `useState`s did not:
 *
 * - **A finished upload is drawn finished before the dialog closes.** antd's
 *   Modal freezes its children the moment `open` turns false (rc-dialog's
 *   `MemoChildren`, `shouldUpdate: visible`) and keeps drawing that frozen
 *   frame for as long as its leave animation runs. When the state reset and
 *   the close land in the same render, the frame it freezes is the one BEFORE
 *   them — the progress bar at 100% and a live "Cancel upload". So success
 *   moves to `done` first, and closing mid-upload (X, Escape) moves to the
 *   cancelled idle frame first; either way the dialog closes from an effect
 *   once that frame has been committed.
 *
 * - **A settled upload only speaks for itself.** Every upload gets a `run`
 *   number, and progress, success and failure carry the number they belong
 *   to. Only the run on screen, and only while it is uploading, is listened
 *   to — so a late answer from a run that was cancelled, or from one that
 *   finished just as Cancel was pressed, cannot drag the dialog back into a
 *   state the person has already left.
 */

export type UploadPhase = 'idle' | 'uploading' | 'done';

export interface UploadDialogState {
  file: File | null;
  options: VideoOptions;
  /** Why the chosen file cannot be uploaded, decided before anything is sent. */
  refusal: string | null;
  /** Why the last upload failed. */
  error: string | null;
  sentBytes: number;
  phase: UploadPhase;
  /**
   * Which upload the in-flight callbacks belong to. Issued by the caller, one
   * per press of Upload, and never reused — so once the dialog has left
   * `uploading`, or moved on to a later run, an old run's callbacks match
   * nothing.
   */
  run: number;
  /**
   * The dialog should close once this frame is on screen — set by closing
   * (X, Escape) during an upload, so the frame the Modal freezes on is the
   * cancelled one, never a live progress bar.
   */
  closeRequested: boolean;
}

export type UploadDialogAction =
  | { type: 'choose'; file: File | null; refusal: string | null }
  | { type: 'option'; field: keyof VideoOptions; value: boolean }
  | { type: 'start'; run: number }
  | { type: 'progress'; run: number; sentBytes: number }
  | { type: 'succeeded'; run: number }
  | { type: 'failed'; run: number; error: string | null }
  /** `close`: the person closed the dialog rather than pressing Cancel upload. */
  | { type: 'cancelled'; close?: boolean }
  | { type: 'reset' };

export const INITIAL_UPLOAD_DIALOG_STATE: UploadDialogState = {
  file: null,
  options: DEFAULT_VIDEO_OPTIONS,
  refusal: null,
  error: null,
  sentBytes: 0,
  phase: 'idle',
  run: 0,
  closeRequested: false,
};

/** Whether a callback from `run` still speaks for what the dialog is showing. */
const isCurrent = (state: UploadDialogState, run: number) =>
  state.phase === 'uploading' && state.run === run;

export function uploadDialogReducer(
  state: UploadDialogState,
  action: UploadDialogAction
): UploadDialogState {
  switch (action.type) {
    case 'choose':
      if (state.phase === 'uploading') return state;
      return {
        ...state,
        file: action.file,
        refusal: action.file ? action.refusal : null,
        options: DEFAULT_VIDEO_OPTIONS,
        error: null,
        sentBytes: 0,
        phase: 'idle',
      };

    case 'option':
      if (state.phase === 'uploading') return state;
      return { ...state, options: applyVideoOption(state.options, action.field, action.value) };

    case 'start':
      if (!state.file || state.refusal || state.phase !== 'idle') return state;
      return { ...state, phase: 'uploading', error: null, sentBytes: 0, run: action.run };

    case 'progress':
      if (!isCurrent(state, action.run)) return state;
      return { ...state, sentBytes: action.sentBytes };

    case 'succeeded':
      if (!isCurrent(state, action.run)) return state;
      return { ...state, phase: 'done', sentBytes: state.file?.size ?? state.sentBytes };

    case 'failed':
      if (!isCurrent(state, action.run)) return state;
      return { ...state, phase: 'idle', sentBytes: 0, error: action.error };

    case 'cancelled': {
      // A close asked for mid-upload is honoured whatever the phase has become
      // since: an upload that finished in the same instant still closes.
      const closing = action.close ? { closeRequested: true } : {};
      // Back to where the person was before they pressed Upload: the file is
      // still chosen, so trying again is one click rather than a second trip
      // through the file picker for a file that may be gigabytes.
      if (state.phase !== 'uploading') return action.close ? { ...state, ...closing } : state;
      return { ...state, phase: 'idle', sentBytes: 0, error: null, ...closing };
    }

    case 'reset':
      return INITIAL_UPLOAD_DIALOG_STATE;
  }
}
