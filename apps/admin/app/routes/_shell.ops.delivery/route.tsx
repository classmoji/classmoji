import { useEffect, useRef, useState } from 'react';
import { Form, Link, useActionData, useFetcher, useLoaderData, useNavigation } from 'react-router';
import { IconAlertTriangle } from '@tabler/icons-react';
import { FilterChips, SearchBox } from '~/components/ui';
import { useNow } from '~/hooks/useNow';
import { relativeTime } from '~/utils/time';
import { contentDeliveryAction, loadContentDelivery } from './route.server';
import type { DeliveryRow } from './route.server';

export const loader = loadContentDelivery;
export const action = contentDeliveryAction;

export const meta = () => [{ title: 'Content delivery · Classmoji Admin' }];

type BulkIntent = 'enable-all' | 'disable-all';

/**
 * A confirmation the app owns.
 *
 * Not `window.confirm`: a native dialog cannot be styled, cannot say which
 * classrooms it is about to touch, and blocks the whole tab while it is up.
 * This one names the count and the direction, which is the entire reason to ask.
 */
const ConfirmBulk = ({
  intent,
  count,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  intent: BulkIntent;
  count: number;
  busy: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) => {
  const enabling = intent === 'enable-all';

  // Escape closes it, which is what every dialog on the web does and what a
  // keyboard user reaches for first.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-confirm-title"
    >
      <div className="w-full max-w-md rounded-2xl bg-panel ring-1 ring-line p-5 shadow-xl">
        <div className="flex items-start gap-3">
          <IconAlertTriangle size={20} className="mt-0.5 shrink-0 text-ink-3" />
          <div className="min-w-0">
            <h2 id="bulk-confirm-title" className="text-sm font-semibold text-ink-0">
              {enabling ? 'Enable content delivery everywhere?' : 'Disable it everywhere?'}
            </h2>
            <p className="mt-1.5 text-sm text-ink-2">
              {enabling
                ? `${count} classroom${count === 1 ? '' : 's'} in the list you are looking at start serving page and deck assets through signed delivery URLs on the next render.`
                : `${count} classroom${count === 1 ? '' : 's'} in the list you are looking at go back to the legacy raw/proxy URLs on the next render.`}{' '}
              Stored content is not touched — this only changes the URLs the apps hand out, and it
              can be reversed from this screen.
            </p>
          </div>
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink-1 hover:bg-nav-hover disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? 'Working…' : enabling ? 'Enable for all' : 'Disable for all'}
          </button>
        </div>
      </div>
    </div>
  );
};

/** One row's switch. A form per row so a failure is scoped to that row. */
const RowToggle = ({ row }: { row: DeliveryRow }) => {
  const fetcher = useFetcher();
  // The submitted value while in flight, so the label flips immediately rather
  // than waiting on a round trip that also revalidates the whole list.
  const pending = fetcher.formData?.get('enabled');
  const enabled = pending === undefined ? row.enabled : pending === 'true';
  const busy = fetcher.state !== 'idle';

  // The action's `{ error }` is only worth returning if something renders it.
  // A row that silently keeps its old state after a failed write is worse than
  // no toggle at all — the admin walks away believing the flag moved.
  const error = (fetcher.data as { error?: string } | undefined)?.error;

  return (
    <fetcher.Form method="post" className="flex flex-col items-end gap-1">
      <input type="hidden" name="intent" value="toggle" />
      <input type="hidden" name="classroomId" value={row.id} />
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      <button
        type="submit"
        disabled={busy}
        aria-pressed={enabled}
        className={
          'rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-40 ' +
          (enabled
            ? 'border-line-strong bg-accent-soft text-ink-0'
            : 'border-line text-ink-2 hover:bg-nav-hover')
        }
      >
        {enabled ? 'On' : 'Off'}
      </button>
      {error ? (
        <span role="alert" className="text-[11px] text-red-600 dark:text-red-400 text-right">
          {error}
        </span>
      ) : null}
    </fetcher.Form>
  );
};

const ContentDelivery = () => {
  const { rows, query, state, enabledCount, totalCount, baseCount, envConfigured } =
    useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const actionData = useActionData<{ error?: string; ok?: boolean; changed?: number }>();
  const now = useNow();
  const [confirming, setConfirming] = useState<BulkIntent | null>(null);

  const bulkIntent = navigation.formData?.get('intent');
  const bulkBusy = bulkIntent === 'enable-all' || bulkIntent === 'disable-all';

  // Close the dialog once the submission it opened has LANDED — which needs the
  // memory of a submission having started. Without it the effect fires on the
  // render that opens the dialog, where the navigation is idle because nothing
  // has been submitted yet, and closes it again before anyone sees it.
  const submitted = useRef(false);
  useEffect(() => {
    if (bulkBusy) {
      submitted.current = true;
      return;
    }
    if (submitted.current && navigation.state === 'idle') {
      submitted.current = false;
      // A failed bulk update keeps the dialog open with the reason on it —
      // closing it would leave an admin looking at an unchanged list with no
      // idea whether the click registered.
      if (!actionData?.error) setConfirming(null);
    }
  }, [bulkBusy, navigation.state, actionData]);

  // How many rows the button in front of you would actually change. "Enable for
  // all" touches the ones that are off; "disable" the ones that are on. Saying
  // "all N classrooms" when N-1 are already there is how a confirmation stops
  // being read.
  const offInList = state === 'on' ? 0 : state === 'off' ? totalCount : baseCount - enabledCount;
  const onInList = state === 'on' ? totalCount : state === 'off' ? 0 : enabledCount;
  const affected = confirming === 'enable-all' ? offInList : onInList;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <FilterChips
          param="state"
          options={[
            { value: '', label: 'All', count: baseCount },
            { value: 'on', label: 'On', count: enabledCount },
            { value: 'off', label: 'Off', count: baseCount - enabledCount },
          ]}
        />
        <div className="flex flex-wrap items-center gap-2">
          <FilterChips
            param="scope"
            options={[
              { value: '', label: 'Not archived' },
              { value: 'all', label: 'Include archived' },
            ]}
          />
          <SearchBox
            query={query}
            placeholder="Search by name, slug, or org…"
            label="Search classrooms"
          />
        </div>
      </div>

      {!envConfigured ? (
        <div className="mb-4 rounded-xl border border-line bg-accent-soft px-4 py-3 text-sm text-ink-1">
          This admin app has no <code>CONTENT_SIGNING_SECRET</code> /{' '}
          <code>CONTENT_DELIVERY_ORIGIN</code>. If the webapp, pages and slides apps lack them too,
          nothing can sign a URL yet: the switches below still record the decision, and take effect
          once the env is set. (This checks the admin app&apos;s environment only.)
        </div>
      ) : null}

      <div className="rounded-2xl bg-panel ring-1 ring-line px-3 py-4 sm:px-4 min-h-[calc(100vh-14rem)]">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3 px-1">
          <p className="text-xs text-ink-3">
            {totalCount} classroom{totalCount === 1 ? '' : 's'} in this list
            {query ? ` · matching “${query}”` : ''} · the buttons change only these
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setConfirming('enable-all')}
              className="rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink-1 hover:bg-nav-hover"
            >
              Enable for all
            </button>
            <button
              type="button"
              onClick={() => setConfirming('disable-all')}
              className="rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink-1 hover:bg-nav-hover"
            >
              Disable for all
            </button>
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <div className="font-medium">No classrooms found</div>
            <div className="text-sm">
              {query ? 'Try a different search term.' : 'No classrooms exist yet.'}
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-ink-4">
                  <th className="font-semibold py-2 pr-4">Classroom</th>
                  <th className="font-semibold py-2 pr-4">Organization</th>
                  <th className="font-semibold py-2 pr-4">Last full sync</th>
                  <th className="font-semibold py-2 pr-4">Live editing</th>
                  <th className="font-semibold py-2 pr-4 text-right">Delivery</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} className="border-t border-line row-hover">
                    <td className="py-1.5 pr-4">
                      <Link
                        to={`/classrooms/${encodeURIComponent(row.slug)}`}
                        className="text-ink-0 font-medium hover:underline"
                      >
                        {row.name}
                      </Link>{' '}
                      <span className="text-ink-3 text-xs">{row.slug}</span>
                      {row.archived ? (
                        <span className="chip chip-ghost ml-1.5">archived</span>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-4 text-ink-2">{row.orgLogin}</td>
                    <td className="py-1.5 pr-4 text-ink-2 whitespace-nowrap">
                      {row.syncedAt ? (
                        relativeTime(row.syncedAt, now)
                      ) : (
                        <span className="text-ink-4">never</span>
                      )}
                      {row.syncedCommit ? (
                        <span className="text-ink-4 text-xs">
                          {' '}
                          · {row.syncedCommit.slice(0, 7)}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-4 whitespace-nowrap">
                      {row.checkpointErrors ? (
                        <span className="chip chip-late">{row.checkpointErrors} failing</span>
                      ) : (
                        <span className={row.collab ? 'text-ink-2' : 'text-ink-4'}>
                          {row.collab ? 'On' : 'Off'}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-4">
                      <div className="flex justify-end">
                        <RowToggle row={row} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {confirming ? (
        <ConfirmBulk
          intent={confirming}
          count={affected}
          busy={bulkBusy}
          error={bulkBusy ? null : actionData?.error}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const form = document.getElementById('bulk-form') as HTMLFormElement | null;
            const field = form?.elements.namedItem('intent') as HTMLInputElement | null;
            if (!form || !field) return;
            field.value = confirming;
            form.requestSubmit();
          }}
        />
      ) : null}

      {/* The bulk submission itself. A single hidden form the dialog fills in,
          rather than two forms inside the dialog, so the dialog stays a pure
          confirmation and the navigation state above can watch one submission. */}
      <Form id="bulk-form" method="post" className="hidden">
        <input type="hidden" name="intent" defaultValue="" />
      </Form>
    </>
  );
};

export default ContentDelivery;
