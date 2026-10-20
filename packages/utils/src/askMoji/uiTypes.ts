/**
 * Ask Moji's UIMessage type, its one tool's schemas and its data parts.
 * Types + Zod only; imported by the task, the services and the webapp.
 *
 * The schemas carry no descriptions: the model never reads these
 * definitions. The task attaches its own (private) descriptions.
 */
import { tool, type InferUITools, type UIMessage, type UIMessageChunk } from 'ai';
import { z } from 'zod';
import { ASK_MOJI_COPY_CODES } from './copy.ts';
import { MAX_SLIDE_INDEX } from './limits.ts';

/** What the model cites: a page or deck by id, or a platform docs page by path. */
export const CiteContentInputSchema = z.object({
  type: z.enum(['page', 'slides', 'platform_docs']),
  id: z.string().max(200).optional(),
  path: z.string().max(500).optional(),
});

/**
 * What the server resolved for a citation. The widget renders a chip only
 * from a call whose output is `ok: true`, never from the input.
 */
export const CiteContentOutputSchema = z.object({
  ok: z.boolean(),
  title: z.string().max(300).optional(),
  url: z.string().max(2000).nullable().optional(),
  type: z.enum(['page', 'slides', 'platform_docs']).optional(),
  id: z.string().max(200).optional(),
  path: z.string().max(500).optional(),
});

export type CiteContentInput = z.infer<typeof CiteContentInputSchema>;
export type CiteContentOutput = z.infer<typeof CiteContentOutputSchema>;

/**
 * The tool set without executes: the typed UI parts and the chat agent's
 * `tools` option (which the SDK uses to convert stored messages, never to
 * call the model). AI SDK v7 requires `outputSchema` on a tool without
 * `execute`.
 */
export const askMojiToolDefs = {
  cite_content: tool({
    inputSchema: CiteContentInputSchema,
    outputSchema: CiteContentOutputSchema,
  }),
};

/** Longest step title: a label, not a payload. */
export const STEP_TITLE_MAX = 200;

/** Where a lookup's step line is: still running, or done. */
export const STEP_STATUSES = ['running', 'done'] as const;
export type AskMojiStepStatus = (typeof STEP_STATUSES)[number];

/**
 * A line while a lookup runs, written by the task (never by the model). The
 * part's id is the tool call's id, so `done` replaces its `running` line.
 * `status` is optional for rows stored before it existed.
 */
export const AskMojiStepDataSchema = z.object({
  title: z.string().min(1).max(STEP_TITLE_MAX),
  status: z.enum(STEP_STATUSES).optional(),
});

/** A fixed line in place of an answer (copy.ts, by code). */
export const AskMojiNoticeDataSchema = z.object({ code: z.enum(ASK_MOJI_COPY_CODES) });

/** Every data part Ask Moji may send; the projection drops any other. */
export const askMojiDataPartSchemas = {
  notice: AskMojiNoticeDataSchema,
  step: AskMojiStepDataSchema,
};

export type AskMojiDataParts = {
  notice: z.infer<typeof AskMojiNoticeDataSchema>;
  step: z.infer<typeof AskMojiStepDataSchema>;
};

/** What a user message may say it was sent from (the page the widget was open on). */
export const VIEWING_KINDS = ['module', 'assignment', 'quiz', 'page', 'deck', 'calendar'] as const;

export type AskMojiViewingKind = (typeof VIEWING_KINDS)[number];

/**
 * What the widget says is open. `slide` is the deck's current slide (0-based,
 * a deck only; the server ignores it on any other kind and clamps it).
 */
export const AskMojiViewingSchema = z
  .object({
    kind: z.enum(VIEWING_KINDS),
    id: z.string().min(1).max(128).optional(),
    slide: z.number().int().min(0).max(MAX_SLIDE_INDEX).optional(),
  })
  .strict();

/**
 * A user message's metadata: at most `viewing`, nothing else (admission
 * refuses any other key). Carried as sent; the task resolves the id against
 * the conversation's classroom before it reads anything by it.
 */
export const AskMojiMessageMetadataSchema = z
  .object({ viewing: AskMojiViewingSchema.optional() })
  .strict();

export type AskMojiViewing = z.infer<typeof AskMojiViewingSchema>;

/** What a browser may send as a user message's metadata (`AskMojiMessageMetadataSchema`). */
export type AskMojiClientMetadata = z.infer<typeof AskMojiMessageMetadataSchema>;

/**
 * A message's metadata as a viewer receives it: a user row's `viewing`, and
 * on an assistant row `rateable` (the server sets it from the row: a final
 * answer written by the model). Never accepted from a browser: admission
 * validates with `AskMojiMessageMetadataSchema`, which refuses `rateable`.
 */
export type AskMojiMessageMetadata = AskMojiClientMetadata & { rateable?: boolean };

export type AskMojiUITools = InferUITools<typeof askMojiToolDefs>;
export type AskMojiUIMessage = UIMessage<AskMojiMessageMetadata, AskMojiDataParts, AskMojiUITools>;
export type AskMojiUIMessagePart = AskMojiUIMessage['parts'][number];
export type AskMojiUIMessageChunk = UIMessageChunk<AskMojiMessageMetadata, AskMojiDataParts>;
