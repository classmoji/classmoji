/**
 * createBlankTemplateRepository: a private repo named `<slug>-template` in the
 * classroom's org, seeded with a README on `main` so it has a root commit, and
 * torn down again if the seed fails. Provider and content service are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createRepository = vi.fn();
const deleteRepository = vi.fn();
const uploadBatch = vi.fn();

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('../../content/ContentService.ts', () => ({
  ContentService: { uploadBatch: (...a: unknown[]) => uploadBatch(...a) },
}));
vi.mock('../../git/index.ts', () => ({
  getGitProvider: () => ({
    createRepository: (...a: unknown[]) => createRepository(...a),
    deleteRepository: (...a: unknown[]) => deleteRepository(...a),
  }),
}));

const { createBlankTemplateRepository } = await import('../templateImport.service.ts');

const org = { provider: 'GITHUB', login: 'cs-dept', github_installation_id: '1' } as never;

beforeEach(() => {
  createRepository.mockReset();
  deleteRepository.mockReset();
  uploadBatch.mockReset();
  createRepository.mockResolvedValue({});
  uploadBatch.mockResolvedValue(undefined);
});

describe('createBlankTemplateRepository', () => {
  it('creates a private <slug>-template repo and seeds a README on main', async () => {
    const result = await createBlankTemplateRepository({
      gitOrganization: org,
      slug: 'lab-3-linked-lists',
      assignmentTitle: 'Lab 3: Linked lists',
      classroomName: 'CS 10',
    });

    expect(createRepository).toHaveBeenCalledWith('cs-dept', 'lab-3-linked-lists-template', true);
    expect(uploadBatch).toHaveBeenCalledTimes(1);
    const args = uploadBatch.mock.calls[0][0];
    expect(args.repo).toBe('lab-3-linked-lists-template');
    expect(args.branch).toBe('main');
    expect(args.allowRootCommit).toBe(true);
    expect(args.files).toHaveLength(1);
    expect(args.files[0].path).toBe('README.md');
    expect(args.files[0].content).toContain('Lab 3: Linked lists');
    expect(result).toEqual({
      fullName: 'cs-dept/lab-3-linked-lists-template',
      name: 'lab-3-linked-lists-template',
    });
    expect(deleteRepository).not.toHaveBeenCalled();
  });

  it('deletes the empty repo and rethrows when the seed commit fails', async () => {
    uploadBatch.mockRejectedValue(new Error('contents api down'));

    await expect(
      createBlankTemplateRepository({
        gitOrganization: org,
        slug: 'hw1',
        assignmentTitle: 'HW1',
        classroomName: 'CS 10',
      })
    ).rejects.toThrow('contents api down');

    expect(deleteRepository).toHaveBeenCalledWith('cs-dept', 'hw1-template');
  });
});
