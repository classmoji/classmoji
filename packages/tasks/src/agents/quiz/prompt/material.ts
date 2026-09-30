/**
 * The SOURCE MATERIAL block: a quiz's linked pages and decks, inlined on the
 * cached side of the prompt. Ported from the ai-agent's `prompts/utils.js`
 * (`usableMaterial`, `buildMaterialPrompt`) without changing a byte of output.
 *
 * Only student-visible documents arrive here: the loader
 * (`ClassmojiService.quizSourceMaterial.load`, called as the attempt's user)
 * drops what this student may not see before the prompt is built, and the
 * titles or reasons of omitted documents never reach it. A truncated
 * document's text already ends in the loader's marker line naming how much was
 * cut, so no second marker is added here.
 *
 * Each header carries the document's id because content_get takes
 * `(classroom, kind, id)`, and the id is how the model names a document whose
 * text here was cut. Tonight the run has no content tools
 * (`contentToolsAvailable: false`), so the block names none.
 *
 * A code-aware quiz with material gets one more rule, right after the
 * precedence line: the material decides the topics, the student's repository
 * is where they are examined.
 */

/** One document as the prompt carries it; `SourceDoc` from the loader fits. */
export type MaterialDoc = {
  kind: string;
  id: string | number;
  title?: string | null;
  text: string;
};

/**
 * The documents a quiz may be built from, in a shape the prompt can carry.
 * Anything without a kind, an id or text is dropped rather than rendered as a
 * header with nothing under it.
 */
export function usableMaterial(sourceMaterial: unknown): MaterialDoc[] {
  if (!Array.isArray(sourceMaterial)) return [];
  return sourceMaterial.filter(
    (doc): doc is MaterialDoc =>
      Boolean(doc) &&
      typeof doc.kind === 'string' &&
      Boolean(doc.kind) &&
      (typeof doc.id === 'string' || typeof doc.id === 'number') &&
      Boolean(String(doc.id)) &&
      typeof doc.text === 'string' &&
      doc.text.trim() !== ''
  );
}

/** The SOURCE MATERIAL block, or '' when there is nothing to say. */
export function buildMaterialPrompt({
  sourceMaterial,
  classroomRef,
  courseSearchEnabled,
  contentToolsAvailable,
  isCodeAware,
}: {
  sourceMaterial: unknown;
  classroomRef: string | null;
  courseSearchEnabled: boolean;
  contentToolsAvailable: boolean;
  isCodeAware: boolean;
}): string {
  const docs = usableMaterial(sourceMaterial);
  const ref = typeof classroomRef === 'string' && classroomRef ? classroomRef : null;
  const toolsOn = Boolean(contentToolsAvailable && ref);
  const searchOn = Boolean(toolsOn && courseSearchEnabled);

  const searchLine = (beyond: string) =>
    `Verification: content_search(classroom: "${ref}", query) and ` +
    `content_list(classroom: "${ref}") can confirm the course covers something` +
    `${beyond}; a miss does not prove absence. Only this classroom. Search hits may be ` +
    `opened in full with content_get(classroom: "${ref}", kind, id) to check what the ` +
    `course actually says.`;

  if (docs.length === 0) {
    if (!searchOn) return '';
    return [`━━━ COURSE SEARCH (classroom: ${ref}) ━━━`, searchLine('')].join('\n');
  }

  const lines = [
    ref ? `━━━ SOURCE MATERIAL (classroom: ${ref}) ━━━` : '━━━ SOURCE MATERIAL ━━━',
    'This quiz is about the documents below.',
    'Evidence precedence: SOURCE MATERIAL decides WHAT to ask; the instructor prompt decides ' +
      'emphasis and tone; the GRADING RUBRIC decides HOW to grade. A topic the material never ' +
      'covers is not asked about, even if the instructor prompt or rubric names it.',
    ...(isCodeAware
      ? [
          "In a code-aware quiz the material decides the topics and the student's repository " +
            "is where they are examined: a question about the student's code is in scope when " +
            'it touches a topic in this material, and out of scope otherwise.',
        ]
      : []),
    'Grading: judge the student against this material. A claim the material does not cover ' +
      'earns no credit toward the question and is noted in feedback as "outside the course ' +
      'material", not marked wrong.',
  ];
  if (toolsOn) {
    lines.push(
      `content_get(classroom: "${ref}", kind, id) returns the whole of a document listed ` +
        'below when its text here was cut.' +
        (searchOn ? '' : ' It reads only the documents listed below.')
    );
  }
  if (searchOn) lines.push(searchLine(' not in this material'));

  const blocks = docs.map(
    doc =>
      `=== ${doc.kind}: ${JSON.stringify(doc.title || 'Untitled')} (id: ${doc.id}) ===\n` +
      doc.text.replace(/\s+$/, '')
  );

  return `${lines.join('\n')}\n\n${blocks.join('\n\n')}`;
}
