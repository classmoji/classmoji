// First: error tracking must be running before the server is built.
import './sentry.ts';

import { ClassmojiService } from '@classmoji/services';
import { flushErrorReports, reportError } from '@classmoji/utils/error-report';

import { createAdapterRegistry } from './adapters/registry.ts';
import { createServiceAuditSink } from './audit.ts';
import { createTaskCheckpointTrigger } from './checkpoint.ts';
import { loadConfig, type CollabConfig } from './config.ts';
import {
  SingleInstanceError,
  createPgInstanceLock,
  holdSingleInstance,
  instanceLockUrl,
} from './instanceLock.ts';
import { reportBootFailure } from './report.ts';
import { createCollabServer } from './server.ts';
import { createSessionResolver } from './session.ts';
import { PrismaCollabDocStore } from './store/prisma.ts';

// A boot failure is reported (fatal, with its surface), then rethrown: the
// process's crash handler prints it, flushes and exits 1, as it always did.
let config: CollabConfig;
try {
  config = loadConfig();
  // ONE INSTANCE ONLY (see instanceLock.ts): refuse to serve while another
  // collab process holds the lock on this database.
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
} catch (err) {
  reportBootFailure(err);
  throw err;
}
let live: { destroy(): Promise<void> } | null = null;
try {
  await holdSingleInstance(createPgInstanceLock(instanceLockUrl()), {
    onLost: reason => {
      console.error(`[collab] FATAL: ${reason}; exiting so only one instance serves`);
      reportError(new Error('collab instance lock lost; exiting'), {
        surface: 'collab.instance_lock',
        level: 'fatal',
        tags: { stage: 'lost' },
      });
      // Flush what this process holds (destroy stores pending docs), then go.
      void (async () => {
        await live?.destroy().catch(() => {});
        await flushErrorReports(2000);
        // A second instance must stop serving, visibly (non-zero exit).
        // eslint-disable-next-line no-process-exit
        process.exit(1);
      })();
    },
  });
} catch (err) {
  if (err instanceof SingleInstanceError) console.error(`[collab] FATAL: ${err.message}`);
  // Every boot failure: `collab.instance_lock` for the lock, `collab.boot`
  // for anything else (a database that never answered).
  reportBootFailure(err);
  await flushErrorReports(2000);
  if (err instanceof SingleInstanceError) {
    // Exit non-zero so a second machine crash-loops where it is seen.
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  }
  throw err;
}

const runtime = createCollabServer({
  // SIGINT/SIGTERM: Hocuspocus destroys the server, which closes sockets and
  // runs flushPendingStores() so every debounced store lands before exit.
  stopOnSignals: true,
  deps: {
    config,
    store: new PrismaCollabDocStore(),
    sessions: createSessionResolver(),
    adapters: createAdapterRegistry(),
    checkpoints: createTaskCheckpointTrigger(config),
    audit: createServiceAuditSink(
      // Only `data` is cast (to the JSON the column takes): the row's other
      // fields, its resource type among them, are checked as they are.
      row =>
        ClassmojiService.audit.record({
          ...row,
          data: row.data as Parameters<typeof ClassmojiService.audit.record>[0]['data'],
        }),
      refusal => ClassmojiService.audit.recordNonMemberRefusal(refusal)
    ),
  },
});

live = runtime;
await runtime.listen();
console.log(
  `[collab] origins: ${[...config.allowedOrigins].join(', ') || '(none)'}; checkpoint delay ${config.checkpointDelay} (max ${config.checkpointMaxDelay})`
);
