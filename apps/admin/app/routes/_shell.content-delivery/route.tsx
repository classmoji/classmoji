import { useEffect, useState } from 'react';
import { Form, useFetcher, useLoaderData, useNavigation } from 'react-router';
import { IconAlertTriangle, IconSearch } from '@tabler/icons-react';
import { useDebouncedSearch } from '~/hooks/useDebouncedSearch';
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
  onCancel,
  onConfirm,
}: {
  intent: BulkIntent;
  count: number;
  busy: boolean;
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
                ? `Every classroom in this list (${count}) starts serving its page and deck assets through signed delivery URLs on the next render.`
                : `Every classroom in this list (${count}) goes back to the legacy raw/proxy URLs on the next render.`}{' '}
              Stored content is not touched — this only changes the URLs the apps
              hand out, and it can be reversed from this screen.
            </p>
          </div>
        </div>
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

  return (
    <fetcher.Form method="post">
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
    </fetcher.Form>
  );
};

const ContentDelivery = () => {
  const { rows, query, enabledCount, totalCount, envConfigured } = useLoaderData<typeof loader>();
  const { inputRef, onSearchChange, searching } = useDebouncedSearch(query);
  const navigation = useNavigation();
  const [confirming, setConfirming] = useState<BulkIntent | null>(null);

  const bulkIntent = navigation.formData?.get('intent');
  const bulkBusy = bulkIntent === 'enable-all' || bulkIntent === 'disable-all';

  // Close the dialog once the submission it opened has landed.
  useEffect(() => {
    if (!bulkBusy && navigation.state === 'idle') setConfirming(null);
  }, [bulkBusy, navigation.state]);

  return (
    <>
      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-lg font-semibold text-ink-1 shrink-0">Content delivery</h1>
        <Form method="get" className="min-w-0" onChange={onSearchChange}>
          <div className="relative min-w-0 sm:w-80">
            <IconSearch
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-4 pointer-events-none"
            />
            <input
              ref={inputRef}
              type="search"
              name="q"
              defaultValue={query}
              placeholder="Search by name, slug, or org…"
              aria-label="Search classrooms"
              className="w-full rounded-md border border-line bg-panel pl-9 pr-8 py-1.5 text-sm text-ink-0 placeholder:text-ink-4 focus:outline-none focus:border-line-strong"
            />
            {searching ? (
              <span
                aria-hidden
                className="absolute right-3 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 border-line-strong border-t-transparent animate-spin"
              />
            ) : null}
          </div>
        </Form>
      </div>

      {!envConfigured ? (
        <div className="mb-4 rounded-xl border border-line bg-accent-soft px-4 py-3 text-sm text-ink-1">
          This deployment has no <code>CONTENT_SIGNING_SECRET</code> /{' '}
          <code>CONTENT_DELIVERY_ORIGIN</code>, so nothing here can sign a URL yet. The switches
          below still record the decision — they simply have no effect until the env is set.
        </div>
      ) : null}

      <div className="rounded-2xl bg-panel ring-1 ring-line px-3 py-4 sm:px-4 min-h-[calc(100vh-14rem)]">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3 px-1">
          <p className="text-xs text-ink-3">
            {enabledCount} of {totalCount} classrooms on
            {query ? ` · ${rows.length} matching “${query}”` : ''}
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
                  <th className="font-semibold py-2 pr-4">Content repo</th>
                  <th className="font-semibold py-2 pr-4 text-right">Delivery</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} className="border-t border-line row-hover">
                    <td className="py-2.5 pr-4">
                      <div className="text-ink-0 font-medium truncate">{row.name}</div>
                      <div className="text-ink-3 text-xs truncate">{row.slug}</div>
                    </td>
                    <td className="py-2.5 pr-4 text-ink-2">{row.orgLogin}</td>
                    <td className="py-2.5 pr-4 text-ink-3 text-xs truncate">{row.contentRepo}</td>
                    <td className="py-2.5 pr-4">
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
          count={totalCount}
          busy={bulkBusy}
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
