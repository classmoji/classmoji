// First: error tracking must be running before the server is built.
import './sentry.ts';

import { ClassmojiService } from '@classmoji/services';
import { flushErrorReports, reportError } from '@classmoji/utils/error-report';

import { createAdapterRegistry } from './adapters/registry.ts';
import { createServiceAuditSink } from './audit.ts';
import { createTaskCheckpointTrigger } from './checkpoint.ts';
import { loadConfig } from './config.ts';
import {
  SingleInstanceError,
  createPgInstanceLock,
  holdSingleInstance,
  instanceLockUrl,
} from './instanceLock.ts';
import { createCollabServer } from './server.ts';
import { createSessionResolver } from './session.ts';
import { PrismaCollabDocStore } from './store/prisma.ts';

const config = loadConfig();

// ONE INSTANCE ONLY (see instanceLock.ts): refuse to serve while another
// collab process holds the lock on this database.
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
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
  if (err instanceof SingleInstanceError) {
    console.error(`[collab] FATAL: ${err.message}`);
    reportError(err, { surface: 'collab.instance_lock', level: 'fatal', tags: { stage: 'boot' } });
    await flushErrorReports(2000);
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
      data => ClassmojiService.audit.record(data as never),
      refusal => ClassmojiService.audit.recordNonMemberRefusal(refusal)
    ),
  },
});

live = runtime;
await runtime.listen();
console.log(
  `[collab] origins: ${[...config.allowedOrigins].join(', ') || '(none)'}; checkpoint delay ${config.checkpointDelay} (max ${config.checkpointMaxDelay})`
);
