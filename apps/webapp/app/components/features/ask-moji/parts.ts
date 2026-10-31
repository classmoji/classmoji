/**
 * What an Ask Moji answer shows, read from its parts. Pure, so the rules
 * that matter (chips only from server-checked cites, steps by id) are tested
 * against data rather than markup.
 */
import { CiteContentOutputSchema, type AskMojiUIMessage } from '@classmoji/utils/ask-moji';
import { buildContentReferenceUrl } from '~/utils/contentReferenceUrl';

export interface AnswerStep {
  id: string;
  title: string;
  done: boolean;
}

/**
 * The lookup lines (`data-step`), in order. A step's part id is its tool
 * call id, so its `done` part replaced its `running` one; a step with no
 * status (older rows) counts as done.
 */
export function stepsOf(message: Pick<AskMojiUIMessage, 'parts'>): AnswerStep[] {
  const out: AnswerStep[] = [];
  const index = new Map<string, number>();
  message.parts.forEach((part, i) => {
    if (part.type !== 'data-step') return;
    const data = part.data as { title?: unknown; status?: unknown } | undefined;
    if (!data || typeof data.title !== 'string' || !data.title) return;
    const id = typeof part.id === 'string' && part.id ? part.id : `step-${i}`;
    const step = { id, title: data.title, done: data.status !== 'running' };
    const at = index.get(id);
    if (at === undefined) {
      index.set(id, out.length);
      out.push(step);
    } else {
      out[at] = step;
    }
  });
  return out;
}

export interface SourceChip {
  key: string;
  type: 'page' | 'slides' | 'platform_docs';
  title: string;
  /** Null: shown as a label, not a link. */
  url: string | null;
}

const httpUrl = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
};

/**
 * The source chips: only `cite_content` calls whose output is available and
 * says `ok: true` (the server checked the citation for this viewer), never
 * the model's input alone. The title is the server's. The link is built by
 * the same helper the old widget used, from the server's type and id/path;
 * the server's own `url` only when that helper has none and it is http(s).
 * One chip per target.
 */
export function sourceChipsOf(
  message: Pick<AskMojiUIMessage, 'parts'>,
  ctx: { classroomSlug: string; pagesUrl: string | null; slidesUrl: string | null }
): SourceChip[] {
  const out: SourceChip[] = [];
  const seen = new Set<string>();
  for (const part of message.parts) {
    if (part.type !== 'tool-cite_content') continue;
    const p = part as { state?: unknown; output?: unknown; input?: unknown };
    if (p.state !== 'output-available') continue;
    const parsed = CiteContentOutputSchema.safeParse(p.output);
    if (!parsed.success || parsed.data.ok !== true) continue;
    const output = parsed.data;
    const input = (p.input ?? {}) as { type?: unknown; id?: unknown; path?: unknown };
    const type = output.type ?? input.type;
    if (type !== 'page' && type !== 'slides' && type !== 'platform_docs') continue;
    const target =
      output.id ??
      output.path ??
      (typeof input.id === 'string' ? input.id : undefined) ??
      (typeof input.path === 'string' ? input.path : undefined);
    const title = output.title?.trim();
    if (!title) continue;
    const key = `${type}:${target ?? title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const built = target
      ? buildContentReferenceUrl(
          { referenceType: type, contentPath: target },
          ctx.classroomSlug,
          ctx.slidesUrl,
          ctx.pagesUrl
        )
      : null;
    out.push({ key, type, title, url: built ?? httpUrl(output.url) });
  }
  return out;
}
