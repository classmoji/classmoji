import { describe, it, expect, vi } from 'vitest';

// projectFromResponse is pure; the module's queries are covered by
// gallery.integration.test.ts against a real database.
vi.mock('@classmoji/database', () => ({
  default: () => {
    throw new Error('projectFromResponse must not touch the database');
  },
}));

import { projectFromResponse } from '../gallery.service.ts';
import type { FormField } from '../formContract.ts';

const f = (id: string, type: string, label: string, extra: Record<string, unknown> = {}) =>
  ({ id, type, label, ...extra }) as FormField;

const FIELDS: FormField[] = [
  f('title', 'short_text', 'Project title', { gallery_role: 'title' }),
  f('tagline', 'short_text', 'Tagline', { gallery_role: 'tagline' }),
  f('summary', 'long_text', 'Summary', { gallery_role: 'summary' }),
  f('icon', 'short_text', 'Icon', { gallery_role: 'icon' }),
  f('cover', 'short_text', 'Cover image URL', { gallery_role: 'cover' }),
  f('team', 'roster_select', 'Team', {
    gallery_role: 'team',
    optionSource: 'roster',
    multiple: true,
    options: [
      { id: 'u1', label: 'Maya Chen (mchen)' },
      { id: 'u2', label: 'slee' },
    ],
  }),
  f('tags', 'short_text', 'Tags', { gallery_role: 'tags' }),
  f('site', 'short_text', 'Deployed URL', { gallery_role: 'link' }),
  f('video', 'short_text', 'Demo video', { gallery_role: 'link' }),
  f('bad', 'short_text', 'Figma', { gallery_role: 'link' }),
  f('problem', 'long_text', 'What is the problem?', { gallery_role: 'detail' }),
  f('creds', 'short_text', 'Demo credentials'),
  // A classroom form fills this from the account: the respondent's own name.
  f('who', 'short_text', 'Full name'),
  f('empty', 'short_text', 'Anything else'),
  f('mail', 'email', 'Email'),
  { id: 'h', type: 'heading', text: 'About' } as FormField,
];

const ANSWERS = {
  title: '  Trail Buddy ',
  tagline: 'Hike together',
  summary: 'Find hiking partners.',
  icon: '🥾',
  cover: 'http://insecure.example/cover.png',
  team: ['u1', 'u2', 'gone'],
  tags: 'maps, social,, ',
  site: 'trailbuddy.app',
  video: 'https://youtu.be/x',
  bad: 'javascript:alert(1)',
  problem: 'Hiking alone is risky.',
  creds: 'demo / demo',
  who: 'Maya Chen',
  empty: '',
  mail: 'maya@example.edu',
};

const CLASSROOM = { name: 'CS52 Fall 2026', slug: 'cs52-f26' };
const RESPONSE = { id: 'r1', submitted_at: new Date('2026-09-01T12:00:00Z'), answers: ANSWERS };

describe('projectFromResponse', () => {
  it('reads every gallery role', () => {
    expect(projectFromResponse(RESPONSE, FIELDS, CLASSROOM)).toMatchObject({
      id: 'r1',
      title: 'Trail Buddy',
      tagline: 'Hike together',
      summary: 'Find hiking partners.',
      icon: '🥾',
      coverUrl: null,
      term: 'CS52 Fall 2026',
      classroomSlug: 'cs52-f26',
      submittedAt: '2026-09-01T12:00:00.000Z',
      team: ['Maya Chen', 'slee'],
      tags: ['maps', 'social'],
      links: [
        { label: 'Deployed URL', url: 'https://trailbuddy.app/' },
        { label: 'Demo video', url: 'https://youtu.be/x' },
      ],
      details: [{ heading: 'What is the problem?', body: 'Hiking alone is risky.' }],
    });
  });

  it('keeps only answered, non-identity input fields as extras', () => {
    const project = projectFromResponse(RESPONSE, FIELDS, CLASSROOM);
    expect(project.extras.map(extra => extra.field.id)).toEqual(['creds']);
  });

  it('accepts an https cover and multiselect tags', () => {
    const fields = FIELDS.map(field =>
      field.id === 'tags'
        ? f('tags', 'multiselect', 'Tags', {
            gallery_role: 'tags',
            options: [
              { id: 'o1', label: 'Maps' },
              { id: 'o2', label: 'Social' },
            ],
          })
        : field
    );
    const project = projectFromResponse(
      { ...RESPONSE, answers: { ...ANSWERS, cover: 'https://img.example/c.png', tags: ['o2'] } },
      fields,
      CLASSROOM
    );
    expect(project.coverUrl).toBe('https://img.example/c.png');
    expect(project.tags).toEqual(['Social']);
  });

  it('falls back to "Untitled project" and empty lists with no answers', () => {
    const project = projectFromResponse({ ...RESPONSE, answers: {} }, FIELDS, CLASSROOM);
    expect(project.title).toBe('Untitled project');
    expect(project.team).toEqual([]);
    expect(project.links).toEqual([]);
    expect(project.extras).toEqual([]);
  });

  it('never publishes identity questions, including legacy fields with gallery roles', () => {
    const fields = [
      f('private', 'long_text', 'Accommodation', { identity_question: true }),
      f('secretTitle', 'short_text', 'Student ID', {
        identity_question: true,
        gallery_role: 'title',
      }),
    ];
    const project = projectFromResponse(
      { ...RESPONSE, answers: { private: 'Private', secretTitle: '1234' } },
      fields,
      CLASSROOM
    );
    expect(project.title).toBe('Untitled project');
    expect(project.extras).toEqual([]);
  });

  it('preserves stable hosted media references and refuses executable video URLs', () => {
    const ref = 'media://11111111-2222-4333-8444-555555555555';
    const fields = [
      f('cover', 'short_text', 'Cover', { gallery_role: 'cover' }),
      f('video', 'short_text', 'Video', { gallery_role: 'video' }),
    ];
    expect(
      projectFromResponse({ ...RESPONSE, answers: { cover: ref, video: ref } }, fields, CLASSROOM)
    ).toMatchObject({ coverUrl: ref, videoUrl: ref, links: [] });
    expect(
      projectFromResponse(
        { ...RESPONSE, answers: { video: 'javascript:alert(1)' } },
        fields,
        CLASSROOM
      ).links
    ).toEqual([]);
  });
});
