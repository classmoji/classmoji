/**
 * The fill page's decisions about starting the next response on a form that
 * takes several responses per person (MANY). Pure, so they can be tested
 * without a browser, and import-free, so the page's client bundle can carry
 * them.
 *
 * ── Why the response count, and not the fetcher's state ────────────────────
 * A submit's reply arrives before the loader data that follows it. Between
 * the two, the page's loader data is still from BEFORE the submit: its
 * `storedAnswers` is the draft that submit just turned into a response. A new
 * response seeded from that would open holding the answers just sent, under
 * "We brought back the answers you started". The count of the person's
 * responses is what tells the two apart: loader data that knows of more
 * responses than the page did when it sent the submit is from after it.
 */

/**
 * Is the loader data from after the submit sent when the person had
 * `sentWithCount` responses? `null` means no submit is in question (the page's
 * first response), and any data is fine.
 */
export function loaderDataAfterSubmit(sentWithCount: number | null, loadedCount: number): boolean {
  return sentWithCount === null || loadedCount > sentWithCount;
}

/**
 * May "Submit another response" be pressed? Only once the submit has finished
 * (its reply and the reload after it) and the loader data shows the response
 * it sent.
 */
export function canStartAnother({
  submitterIdle,
  sentWithCount,
  loadedCount,
}: {
  submitterIdle: boolean;
  sentWithCount: number | null;
  loadedCount: number;
}): boolean {
  return submitterIdle && loaderDataAfterSubmit(sentWithCount, loadedCount);
}

/**
 * What a new response's form is prefilled from. A form started after a submit
 * (`startedAfterCount`, the count when that submit was sent) takes nothing
 * from loader data older than that submit: no answers and no "brought back"
 * notice. Otherwise the loader's draft stands.
 */
export function seedForNewResponse<T>({
  startedAfterCount,
  loadedCount,
  storedAnswers,
  restoredDraft,
}: {
  startedAfterCount: number | null;
  loadedCount: number;
  storedAnswers: T | null;
  restoredDraft: boolean;
}): { storedAnswers: T | null; restoredDraft: boolean } {
  if (!loaderDataAfterSubmit(startedAfterCount, loadedCount)) {
    return { storedAnswers: null, restoredDraft: false };
  }
  return { storedAnswers, restoredDraft };
}
