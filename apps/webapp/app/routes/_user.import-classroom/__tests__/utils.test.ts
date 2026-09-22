import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { parseExportBundle, slugify } from '../utils.ts';

/** Build an in-memory zip from a path→content map (content stringified if not a string). */
async function buildZip(files: Record<string, unknown>): Promise<Blob> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  return buf as unknown as Blob;
}

const GRADES_CSV = [
  'assignment_name,assignment_url,starter_code_url,github_username,roster_identifier,student_repository_name,student_repository_url,submission_timestamp,points_awarded,points_available',
  'HW1,u,s,alice,,hw1-alice,r,2025-01-02T00:00:00Z,80,100', // real score → kept
  'HW1,u,s,bob,,hw1-bob,r,,0,0', // zero points → skipped
].join('\n');

/** A representative bundle under a `export/` root folder. */
function sampleFiles(root = 'export/'): Record<string, unknown> {
  return {
    [`${root}classrooms.json`]: [
      { id: 1, name: 'CS1', archived: false },
      { id: 2, name: 'CS2', archived: true },
    ],
    [`${root}classroom-1/classroom.json`]: {
      id: 1,
      name: 'CS1',
      archived: false,
      organization: { id: 100, login: 'org-one', name: 'Org One', avatar_url: 'http://a' },
    },
    [`${root}classroom-1/assignments.json`]: [
      { id: 11, title: 'HW1', slug: 'hw1', type: 'individual' },
    ],
    [`${root}classroom-1/assignment-11/assignment.json`]: {
      id: 11,
      title: 'HW1',
      slug: 'hw1',
      type: 'individual',
      deadline: '2025-01-01T00:00:00Z',
      starter_code_repository: { full_name: 'org-one/hw1-template' },
    },
    [`${root}classroom-1/assignment-11/accepted-assignments.json`]: [
      {
        id: 111,
        students: [{ id: 1001, login: 'alice', name: 'Alice', avatar_url: 'http://x' }],
        repository: {
          id: 5001,
          name: 'hw1-alice',
          full_name: 'org-one/hw1-alice',
          default_branch: 'main',
        },
      },
      {
        id: 112,
        students: [{ id: 1002, login: 'bob', name: '', avatar_url: '' }],
        repository: { id: 5002, name: 'hw1-bob' },
      },
    ],
    [`${root}classroom-1/assignment-11/grades.csv`]: GRADES_CSV,
    // Classroom 2: archived, no assignments.
    [`${root}classroom-2/classroom.json`]: {
      id: 2,
      name: 'CS2',
      archived: true,
      organization: { id: 100, login: 'org-one', name: 'Org One' },
    },
    [`${root}classroom-2/assignments.json`]: [],
  };
}

describe('parseExportBundle', () => {
  it('maps classrooms, assignments, roster, repos and skips zero-point grades', async () => {
    const bundle = await parseExportBundle(await buildZip(sampleFiles()));

    expect(bundle.rootName).toBe('export');
    expect(bundle.classrooms).toHaveLength(2);

    const cs1 = bundle.classrooms.find(c => c.githubId === 1)!;
    expect(cs1.organization).toMatchObject({ id: 100, login: 'org-one', name: 'Org One' });
    expect(cs1.assignmentCount).toBe(1);
    expect(cs1.studentCount).toBe(2);

    const hw1 = cs1.assignments[0];
    expect(hw1).toMatchObject({
      githubId: 11,
      title: 'HW1',
      type: 'individual',
      deadline: '2025-01-01T00:00:00Z',
      starterRepoFullName: 'org-one/hw1-template',
    });
    expect(hw1.acceptances).toHaveLength(2);

    // bob's empty name coerces to null; alice's repo is linked.
    const bob = hw1.acceptances.find(a => a.students[0].login === 'bob')!;
    expect(bob.students[0].name).toBeNull();
    const alice = hw1.acceptances.find(a => a.students[0].login === 'alice')!;
    expect(alice.repo).toMatchObject({ providerId: '5001', name: 'hw1-alice' });

    // Every grades.csv row is kept (including bob's 0/0) — points stored as-is.
    expect(cs1.grades).toHaveLength(2);
    expect(cs1.grades.find(g => g.githubUsername === 'alice')).toMatchObject({
      pointsAwarded: '80',
      pointsAvailable: '100',
      assignmentTitle: 'HW1',
    });
    expect(cs1.grades.find(g => g.githubUsername === 'bob')).toMatchObject({
      pointsAwarded: '0',
      pointsAvailable: '0',
    });

    const cs2 = bundle.classrooms.find(c => c.githubId === 2)!;
    expect(cs2.archived).toBe(true);
    expect(cs2.assignmentCount).toBe(0);
    expect(cs2.studentCount).toBe(0);
  });

  it('detects the bundle root whether the folder or its contents were zipped', async () => {
    // No `export/` prefix — classrooms.json sits at the archive root.
    const bundle = await parseExportBundle(await buildZip(sampleFiles('')));
    expect(bundle.classrooms).toHaveLength(2);
    expect(bundle.classrooms.find(c => c.githubId === 1)!.studentCount).toBe(2);
  });

  it('coerces group type and tolerates missing accepted-assignments', async () => {
    const files: Record<string, unknown> = {
      'classrooms.json': [{ id: 9, name: 'Teams', archived: false }],
      'classroom-9/classroom.json': {
        id: 9,
        name: 'Teams',
        organization: { id: 7, login: 'org-9', name: null },
      },
      'classroom-9/assignments.json': [{ id: 90, title: 'Group Project', type: 'group' }],
      // assignment.json + accepted-assignments.json intentionally absent.
      'classroom-9/assignment-90/assignment.json': {
        id: 90,
        title: 'Group Project',
        type: 'group',
      },
    };
    const bundle = await parseExportBundle(await buildZip(files));
    const a = bundle.classrooms[0].assignments[0];
    expect(a.type).toBe('group');
    expect(a.acceptances).toEqual([]);
    expect(bundle.classrooms[0].organization.name).toBeNull();
  });

  it('rejects an archive with no classrooms.json', async () => {
    await expect(parseExportBundle(await buildZip({ 'readme.txt': 'hi' }))).rejects.toThrow(
      /classrooms\.json/
    );
  });
});

describe('slugify', () => {
  it('matches the create-classroom slug rules', () => {
    expect(slugify('Rendering Algorithms Fall 2024')).toBe('rendering-algorithms-fall-2024');
    expect(slugify('  CS87 -- Dartmouth!  ')).toBe('cs87-dartmouth');
  });
});
