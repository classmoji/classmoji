import { describe, it, expect, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { assertGalleryMediaAnswers } from '../galleryMedia.ts';
import { FORM_ANSWERS_INVALID, parseFormDefinition } from '../formContract.ts';

const fields = parseFormDefinition([
  { type: 'short_text', label: 'Cover', gallery_role: 'cover' },
  { type: 'short_text', label: 'Video', gallery_role: 'video' },
]).fields;
const id = '11111111-2222-4333-8444-555555555555';
const findFirst = vi.fn();
const client = {
  classroom: {
    findUniqueOrThrow: async () => ({ id: 'class', content_repo: null, git_organization: null }),
  },
  mediaObject: { findFirst },
} as unknown as Prisma.TransactionClient;
const submit = (answers: Record<string, unknown>) =>
  assertGalleryMediaAnswers(client, {
    classroomId: 'class',
    formId: 'form',
    userId: 'student',
    fields,
    answers,
  });

describe('gallery media ownership', () => {
  it('accepts only a completed upload owned by this respondent, form, field, classroom and kind', async () => {
    findFirst.mockResolvedValue({ id });
    expect(await submit({ [fields[0].id]: `media://${id}` })).toEqual({
      [fields[0].id]: `media://${id}`,
    });
    expect(findFirst).toHaveBeenLastCalledWith({
      where: {
        id,
        classroom_id: 'class',
        uploaded_by: 'student',
        gallery_form_id: 'form',
        gallery_field_id: fields[0].id,
        status: 'READY',
        kind: 'IMAGE',
      },
      select: { id: true },
    });
    await submit({ [fields[1].id]: `media://${id}` });
    expect(findFirst.mock.lastCall?.[0].where.kind).toBe('VIDEO');
  });

  it('refuses missing, unfinished or foreign uploads and malformed refs', async () => {
    findFirst.mockResolvedValue(null);
    for (const ref of [`media://${id}`, 'media://guessed']) {
      await expect(submit({ [fields[0].id]: ref })).rejects.toMatchObject({
        code: FORM_ANSWERS_INVALID,
      });
    }
  });

  it('keeps pasted links and empty answers available without hosting', async () => {
    findFirst.mockClear();
    const answers = { [fields[0].id]: 'https://example.test/cover.png', [fields[1].id]: '' };
    expect(await submit(answers)).toEqual(answers);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('refuses a gallery role on a private identity question', () => {
    expect(() =>
      parseFormDefinition([
        { type: 'short_text', label: 'Student ID', identity_question: true, gallery_role: 'title' },
      ])
    ).toThrow(/identity/i);
  });
});
