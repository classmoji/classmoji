/**
 * Ask Moji's projection registry: what the user sees of each tool and data
 * part (see agents/projection.ts), live and on every read.
 *
 * Only `cite_content` is declared, and `shown`: the widget builds its chips
 * from the call's output. Every MCP tool the task offers is undeclared, so
 * hidden: its parts (course text, other people's records) never reach the
 * browser, and progress shows through `data-step` lines the task writes.
 * Reasoning never passes.
 */
import type { Registry } from '../agents/projection.ts';
import { askMojiDataPartSchemas, type AskMojiDataParts } from './uiTypes.ts';

export const askMojiVisibility = {
  tools: { cite_content: 'shown' },
  dataParts: askMojiDataPartSchemas,
} as const satisfies Registry<'cite_content', keyof AskMojiDataParts & string>;
