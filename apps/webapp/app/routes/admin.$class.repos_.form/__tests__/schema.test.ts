import { describe, expect, it } from 'vitest';
import { makeSchema } from '../schema.ts';

/** The rest of what the new-repository form submits. */
const rest = {
  organization: 'cs101',
  type: 'INDIVIDUAL',
  description: '',
  team_formation_mode: 'INSTRUCTOR',
  team_formation_deadline: null,
  max_team_size: null,
  project_template_id: null,
  project_template_title: null,
};

const messagesOf = (value: unknown) => {
  const result = makeSchema('A template repository must be selected.').safeParse(value);
  return result.success
    ? {}
    : Object.fromEntries(result.error.issues.map(issue => [issue.path.join('.'), issue.message]));
};

describe('the repository form', () => {
  it('refuses an empty title and template with its own words', () => {
    expect(messagesOf({ ...rest, title: '', template: '' })).toEqual({
      title: 'Assignment must have a title.',
      template: 'A template repository must be selected.',
    });
  });

  it('accepts a title and a template', () => {
    expect(messagesOf({ ...rest, title: 'Lab 1', template: 'lab-1-starter' })).toEqual({});
  });
});
