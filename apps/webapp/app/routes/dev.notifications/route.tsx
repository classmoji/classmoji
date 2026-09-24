import { useEffect, useRef, useState } from 'react';
import { requireAuth } from '@classmoji/auth/server';
import { useCallout } from '@classmoji/ui-components';
import { LockedBanner } from '~/components/features/classroom/LockedBanner';
import type { Route } from './+types/route';

/**
 * A bench for the notification surfaces. Every callout variant and every banner
 * tone on one page, so a change to the shared styles can be checked in one look
 * instead of by hunting for an action that happens to fire the right one.
 *
 * Signed-in only, and deliberately not linked from anywhere: it is a workshop,
 * not a feature.
 */
export const loader = async ({ request }: Route.LoaderArgs) => {
  await requireAuth(request);
  return null;
};

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-wrap items-center gap-2 py-2">
    <span className="w-44 shrink-0 text-sm text-ink-3">{label}</span>
    {children}
  </div>
);

const Section = ({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) => (
  <section className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6">
    <h2 className="text-base font-semibold text-ink-1">{title}</h2>
    {note ? <p className="mt-1 mb-3 text-sm text-ink-3">{note}</p> : <div className="mb-2" />}
    <div className="divide-y divide-line">{children}</div>
  </section>
);

const DevNotifications = () => {
  const callout = useCallout();
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [running, setRunning] = useState(false);

  const later = (ms: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, ms));
  };

  /**
   * Walks a progress callout from nothing to done, the way a real Trigger.dev
   * batch does: counts that climb, then a resolution that either settles
   * quietly or stays put with something to click.
   */
  const runJob = (outcome: 'success' | 'failure') => {
    if (running) return;
    setRunning(true);
    const total = 30;
    const id = callout.show({
      variant: 'progress',
      title: 'Creating student repositories',
      message: `0 of ${total} repositories`,
      progress: 0,
      persistent: true,
    });

    for (let done = 1; done <= total; done++) {
      later(done * 120, () => {
        callout.update(id, {
          variant: 'progress',
          title: 'Creating student repositories',
          message: `${done} of ${total} repositories`,
          progress: done / total,
          persistent: true,
        });
      });
    }

    later(total * 120 + 400, () => {
      if (outcome === 'success') {
        callout.update(id, {
          variant: 'success',
          title: 'Student repositories created',
          message: `${total} repositories`,
          progress: undefined,
          persistent: false,
          autoDismissMs: 4000,
        });
      } else {
        callout.update(id, {
          variant: 'error',
          title: `28 of ${total} repositories finished`,
          message: '2 could not be completed',
          progress: undefined,
          persistent: true,
          action: {
            label: 'Details',
            onClick: () =>
              callout.show({ variant: 'info', title: 'This is where the run log would open' }),
          },
        });
      }
      setRunning(false);
    });
  };

  // The key `useNotifiedFetcher` parks a running batch under.
  const OPERATION_KEY = 'classmoji.operation';
  const [parked, setParked] = useState(false);

  // Polled rather than read once: the resume clears the key as soon as it
  // settles, so a mount-time snapshot goes stale within a second of landing.
  useEffect(() => {
    const read = () => {
      try {
        setParked(sessionStorage.getItem(OPERATION_KEY) !== null);
      } catch {
        /* Storage blocked: the readout stays false. */
      }
    };
    read();
    const timer = setInterval(read, 500);
    return () => clearInterval(timer);
  }, []);

  /**
   * Park a batch the way a real action does, so a reload has something to pick
   * up. The token is fake, which the resume cannot know until it tries: it comes
   * back, fails to subscribe, and says so. That failure is the proof it ran.
   */
  const parkFake = (thenReload: boolean) => {
    try {
      sessionStorage.setItem(
        OPERATION_KEY,
        JSON.stringify({
          session: { id: `bench-${Date.now()}`, accessToken: 'pk_bench_not_a_real_token' },
          startedAt: Date.now(),
        })
      );
      setParked(true);
      if (thenReload) window.location.reload();
    } catch {
      callout.show({ variant: 'error', title: 'This browser is blocking storage' });
    }
  };

  const clearParked = () => {
    try {
      sessionStorage.removeItem(OPERATION_KEY);
    } catch {
      /* Nothing to clear. */
    }
    setParked(false);
  };

  const stop = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setRunning(false);
  };

  return (
    <div className="min-h-full bg-bg-page">
      <div className="mx-auto max-w-3xl px-5 py-10 flex flex-col gap-4">
        <header>
          <h1 className="text-2xl font-bold text-ink-1">Notification bench</h1>
          <p className="mt-1 text-ink-2">
            Every transient surface in one place. Callouts appear at the top of the viewport, one at
            a time: firing a second one replaces the first.
          </p>
        </header>

        <Section title="Callouts" note="The four variants, each with and without the second line.">
          <Row label="Success">
            <button
              className="btn btn-sm"
              onClick={() => callout.show({ variant: 'success', title: 'Settings saved' })}
            >
              Title only
            </button>
            <button
              className="btn btn-sm"
              onClick={() =>
                callout.show({
                  variant: 'success',
                  title: 'Student repositories created',
                  message: '30 repositories',
                })
              }
            >
              With message
            </button>
          </Row>

          <Row label="Error">
            <button
              className="btn btn-sm"
              onClick={() =>
                callout.show({ variant: 'error', title: 'Could not save the classroom' })
              }
            >
              Title only
            </button>
            <button
              className="btn btn-sm"
              onClick={() =>
                callout.show({
                  variant: 'error',
                  title: 'Could not reach Github',
                  message: 'The organization declined the request',
                  action: {
                    label: 'Retry',
                    onClick: () => callout.show({ variant: 'info', title: 'Retrying' }),
                  },
                })
              }
            >
              With action
            </button>
          </Row>

          <Row label="Info">
            <button
              className="btn btn-sm"
              onClick={() =>
                callout.show({ variant: 'info', title: 'A presentation needs at least one slide' })
              }
            >
              Title only
            </button>
            <button
              className="btn btn-sm"
              onClick={() =>
                callout.show({
                  variant: 'info',
                  title: 'Your email is unverified',
                  message: 'Some features stay locked until it is',
                  persistent: true,
                  action: { label: 'Change email', onClick: () => {} },
                })
              }
            >
              Persistent, with action
            </button>
          </Row>

          <Row label="Progress">
            <button
              className="btn btn-sm"
              onClick={() =>
                callout.show({
                  variant: 'progress',
                  title: 'Publishing',
                  persistent: true,
                })
              }
            >
              No count
            </button>
            <button
              className="btn btn-sm"
              onClick={() =>
                callout.show({
                  variant: 'progress',
                  title: 'Creating student repositories',
                  message: '18 of 30 repositories',
                  progress: 0.6,
                  persistent: true,
                })
              }
            >
              Held at 60%
            </button>
          </Row>
        </Section>

        <Section
          title="A whole operation"
          note="What a real Trigger.dev batch looks like: counts climbing for about four seconds, then a resolution."
        >
          <Row label="Run one">
            <button className="btn btn-sm" disabled={running} onClick={() => runJob('success')}>
              Finishes cleanly
            </button>
            <button className="btn btn-sm" disabled={running} onClick={() => runJob('failure')}>
              Two fail
            </button>
            <button className="btn btn-sm" onClick={stop}>
              Stop
            </button>
          </Row>
        </Section>

        <Section
          title="Surviving a reload"
          note="A running batch is parked in sessionStorage, so a refresh picks it back up instead of losing sight of work that is still going."
        >
          <Row label="Fake batch">
            <button className="btn btn-sm" onClick={() => parkFake(true)}>
              Park and reload now
            </button>
            <button className="btn btn-sm" onClick={() => parkFake(false)}>
              Park only, I will reload
            </button>
            <button className="btn btn-sm" onClick={clearParked} disabled={!parked}>
              Clear
            </button>
            <span className="text-sm text-ink-3">
              {parked ? 'A batch is parked' : 'Nothing parked'}
            </span>
          </Row>
          <div className="py-2 text-sm text-ink-3">
            The bench cannot mint a real Trigger token, so after the reload the callout comes back
            and then reports that it lost the batch. That is the resume working. To watch one
            actually resume, publish or sync a repository and refresh while it runs.
          </div>
        </Section>

        <Section title="Edge cases" note="The shapes that break a fixed-width card.">
          <Row label="Long">
            <button
              className="btn btn-sm"
              onClick={() =>
                callout.show({
                  variant: 'error',
                  title:
                    'The repository template could not be cloned because the source organization has disabled forking',
                  message: 'Check the template settings on Github and try again',
                  action: { label: 'Details', onClick: () => {} },
                })
              }
            >
              Long title, message and action
            </button>
          </Row>
          <Row label="Replacement">
            <button
              className="btn btn-sm"
              onClick={() => {
                callout.show({ variant: 'info', title: 'First' });
                later(600, () => callout.show({ variant: 'success', title: 'Second replaces it' }));
              }}
            >
              Two in a row
            </button>
          </Row>
        </Section>

        <Section
          title="Banners"
          note="Standing conditions. Same spacing and radius as a callout, but they belong to the page rather than floating over it."
        >
          <div className="flex flex-col gap-3 py-3">
            <LockedBanner />
            <div className="cm-banner cm-banner-accent">
              Importing from CS10 Fall 2025. This keeps going if you navigate away.
            </div>
            <div className="cm-banner cm-banner-rose">
              Import stopped. Three repositories could not be created.
            </div>
          </div>
        </Section>
      </div>
    </div>
  );
};

export default DevNotifications;
