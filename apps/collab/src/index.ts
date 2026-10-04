import { createAdapterRegistry } from './adapters/registry.ts';
import { createTaskCheckpointTrigger } from './checkpoint.ts';
import { loadConfig } from './config.ts';
import { createCollabServer } from './server.ts';
import { createSessionResolver } from './session.ts';
import { PrismaCollabDocStore } from './store/prisma.ts';

const config = loadConfig();

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
  },
});

await runtime.listen();
console.log(
  `[collab] origins: ${[...config.allowedOrigins].join(', ') || '(none)'}; checkpoint delay ${config.checkpointDelay} (max ${config.checkpointMaxDelay})`
);
