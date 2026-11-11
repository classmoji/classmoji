import { zodResolver } from '@hookform/resolvers/zod';
import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { makeSchema } from '../schema.ts';

/** What the form hands react-hook-form's resolver on submit. */
const submitted = {
  organization: 'cs101',
  type: 'INDIVIDUAL',
  description: '',
  team_formation_mode: 'INSTRUCTOR',
  team_formation_deadline: null,
  max_team_size: null,
  project_template_id: null,
  project_template_title: null,
};

const resolve = (values: Record<string, unknown>) =>
  zodResolver(makeSchema('A template repository must be selected.'))(values as never, undefined, {
    fields: {},
    shouldUseNativeValidation: false,
  });

describe('the repository form resolver', () => {
  it('puts the refusal on the field, in the schema’s words', async () => {
    const { errors, values } = await resolve({ ...submitted, title: '', template: '' });
    expect(values).toEqual({});
    expect(errors).toMatchObject({
      title: { message: 'Assignment must have a title.' },
      template: { message: 'A template repository must be selected.' },
    });
  });

  it('returns the parsed values for a valid form', async () => {
    const { errors, values } = await resolve({
      ...submitted,
      title: 'lab-1',
      template: 'lab-1-starter',
      team_formation_deadline: '2026-11-12T17:00:00Z',
    });
    expect(errors).toEqual({});
    expect(values).toMatchObject({ title: 'lab-1', template: 'lab-1-starter' });
    expect(
      dayjs.isDayjs((values as { team_formation_deadline: unknown }).team_formation_deadline)
    ).toBe(true);
  });
});
