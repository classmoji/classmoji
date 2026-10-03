/**
 * The upload dialog's transitions.
 *
 * What these guard is what a person sees at the two moments that matter most:
 * right after an upload finishes, and right after they press Cancel. Both went
 * wrong in a real browser — a finished upload left a live "Cancel upload" on
 * screen — and neither is reachable from the node-environment component tests,
 * so the state behind the dialog is asserted here directly.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_VIDEO_OPTIONS } from '@classmoji/ui-components/media-options';
import {
  INITIAL_UPLOAD_DIALOG_STATE,
  uploadDialogReducer,
  type UploadDialogAction,
  type UploadDialogState,
} from '../uploadDialogState';

const file = new File([new Uint8Array(5_000)], 'grades.csv', { type: 'text/csv' });

const apply = (actions: UploadDialogAction[], from = INITIAL_UPLOAD_DIALOG_STATE) =>
  actions.reduce<UploadDialogState>(uploadDialogReducer, from);

/** A file chosen and an upload (run 1) under way, part of the way through. */
const uploading = apply([
  { type: 'choose', file, refusal: null },
  { type: 'option', field: 'allowDownload', value: true },
  { type: 'start', run: 1 },
  { type: 'progress', run: 1, sentBytes: 1_000 },
]);

describe('starting', () => {
  it('uploads the chosen file under the run it was given', () => {
    expect(uploading).toMatchObject({ phase: 'uploading', run: 1, sentBytes: 1_000, file });
  });

  it('does not start with no file, a refused file, or one already going', () => {
    expect(apply([{ type: 'start', run: 1 }]).phase).toBe('idle');
    expect(
      apply([
        { type: 'choose', file, refusal: 'too big' },
        { type: 'start', run: 1 },
      ]).phase
    ).toBe('idle');
    expect(uploadDialogReducer(uploading, { type: 'start', run: 2 }).run).toBe(1);
  });
});

describe('after a successful upload', () => {
  const done = uploadDialogReducer(uploading, { type: 'succeeded', run: 1 });

  it('is finished, not still uploading — nothing left to cancel', () => {
    expect(done.phase).toBe('done');
    expect(done.sentBytes).toBe(file.size);
  });

  it('opens fresh next time: the reset on close clears the file and the options', () => {
    const reopened = uploadDialogReducer(done, { type: 'reset' });

    expect(reopened).toEqual(INITIAL_UPLOAD_DIALOG_STATE);
    expect(reopened.options).toEqual(DEFAULT_VIDEO_OPTIONS);
  });

  it('ignores a late progress report from the finished run', () => {
    expect(uploadDialogReducer(done, { type: 'progress', run: 1, sentBytes: 10 })).toBe(done);
  });
});

describe('after Cancel', () => {
  const cancelled = uploadDialogReducer(uploading, { type: 'cancelled' });

  it('is back to idle at once, with the file still chosen and no error', () => {
    expect(cancelled).toMatchObject({ phase: 'idle', sentBytes: 0, error: null, file });
    // The choices made before pressing Upload are still the ones on screen.
    expect(cancelled.options.allowDownload).toBe(true);
  });

  it('stays quiet when the cancelled run settles later', () => {
    // The upload client rejects with ABORTED after a cancel; the dialog maps
    // that to `error: null`, but even a real error from a run the person has
    // already walked away from must not appear.
    expect(uploadDialogReducer(cancelled, { type: 'failed', run: 1, error: null })).toBe(cancelled);
    expect(
      uploadDialogReducer(cancelled, { type: 'failed', run: 1, error: 'network' }).error
    ).toBeNull();
    expect(uploadDialogReducer(cancelled, { type: 'progress', run: 1, sentBytes: 4_000 })).toBe(
      cancelled
    );
  });

  it('does not close itself if the cancelled run turns out to have finished', () => {
    expect(uploadDialogReducer(cancelled, { type: 'succeeded', run: 1 }).phase).toBe('idle');
  });

  it('lets the same file go again, and the old run cannot touch the new one', () => {
    const again = uploadDialogReducer(cancelled, { type: 'start', run: 2 });
    expect(again).toMatchObject({ phase: 'uploading', run: 2, sentBytes: 0 });

    const afterStale = apply(
      [
        { type: 'progress', run: 1, sentBytes: 4_999 },
        { type: 'failed', run: 1, error: 'network' },
        { type: 'succeeded', run: 1 },
      ],
      again
    );
    expect(afterStale).toBe(again);
  });
});

describe('after a failure', () => {
  it('shows the message and allows another try', () => {
    const failed = uploadDialogReducer(uploading, {
      type: 'failed',
      run: 1,
      error: 'The upload could not finish.',
    });

    expect(failed).toMatchObject({ phase: 'idle', error: 'The upload could not finish.' });
    expect(uploadDialogReducer(failed, { type: 'start', run: 2 }).phase).toBe('uploading');
  });
});

describe('while uploading', () => {
  it('holds the file and the options still', () => {
    const other = new File([new Uint8Array(1)], 'other.mp4');

    expect(uploadDialogReducer(uploading, { type: 'choose', file: other, refusal: null })).toBe(
      uploading
    );
    expect(
      uploadDialogReducer(uploading, { type: 'option', field: 'optimise', value: false })
    ).toBe(uploading);
  });
});

describe('closing during an upload (X, Escape)', () => {
  const closing = uploadDialogReducer(uploading, { type: 'cancelled', close: true });

  it('cancels first — the frame left to freeze is idle, not a live upload — then asks to close', () => {
    expect(closing).toMatchObject({ phase: 'idle', sentBytes: 0, closeRequested: true });
  });

  it('plain Cancel upload does not ask to close', () => {
    expect(uploadDialogReducer(uploading, { type: 'cancelled' }).closeRequested).toBe(false);
  });

  it('still closes when the upload finished in the same instant', () => {
    const done = uploadDialogReducer(uploading, { type: 'succeeded', run: 1 });
    expect(uploadDialogReducer(done, { type: 'cancelled', close: true }).closeRequested).toBe(true);
  });

  it('opens fresh next time, with no close pending', () => {
    expect(uploadDialogReducer(closing, { type: 'reset' })).toEqual(INITIAL_UPLOAD_DIALOG_STATE);
    expect(INITIAL_UPLOAD_DIALOG_STATE.closeRequested).toBe(false);
  });
});
