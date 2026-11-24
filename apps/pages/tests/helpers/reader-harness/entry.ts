/**
 * Browser entry for the unit suite's reader harness (`readerHarness.ts`): the
 * reader island's own mount, the one the class site and the MCP's page render
 * run, mounted from the data block the harness writes into the page.
 */
import { mountReaderIsland } from '~/reader-island/mount.tsx';

mountReaderIsland({});
