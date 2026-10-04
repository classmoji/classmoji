import { createCollabServer } from './server.ts';

const server = createCollabServer();
await server.listen();
