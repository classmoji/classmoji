import { describe, it, expect } from 'vitest';
import { resolveSourceAccess, API_KEYS_STRIPPED_WARNING, SOURCE_ROLES } from '../sourceAccess.ts';

/**
 * The import source gate. Owners and teachers may copy a class; only owners may
 * copy its API keys, because those are the source owner's real LLM credentials
 * and everything else in an import is course material a teacher can already read.
 */
describe('resolveSourceAccess', () => {
  describe('who may import at all', () => {
    it('admits an owner', () => {
      expect(resolveSourceAccess(['OWNER']).allowed).toBe(true);
    });

    it('admits a teacher', () => {
      expect(resolveSourceAccess(['TEACHER']).allowed).toBe(true);
    });

    // These two are the denial coverage. They were the ONLY outcome before
    // teachers were admitted; the teacher case flipped, these did not.
    it('refuses an assistant', () => {
      expect(resolveSourceAccess(['ASSISTANT']).allowed).toBe(false);
    });

    it('refuses a student', () => {
      expect(resolveSourceAccess(['STUDENT']).allowed).toBe(false);
    });

    it('refuses someone with no membership at all', () => {
      expect(resolveSourceAccess([]).allowed).toBe(false);
    });

    // An assistant who is ALSO a teacher is admitted on the teacher row; the
    // assistant row neither grants nor blocks anything.
    it('admits on the usable role when a non-usable role is also held', () => {
      expect(resolveSourceAccess(['ASSISTANT', 'TEACHER']).allowed).toBe(true);
    });

    it('does not treat an unknown role as usable', () => {
      expect(resolveSourceAccess(['SUPERUSER']).allowed).toBe(false);
    });
  });

  describe('API keys are owner-only', () => {
    it('lets an owner copy them', () => {
      const access = resolveSourceAccess(['OWNER'], { grading: true, apiKeys: true });
      expect(access).toMatchObject({ allowed: true, isOwner: true });
      if (!access.allowed) throw new Error('expected allowed');
      expect(access.configSelections.apiKeys).toBe(true);
      expect(access.warnings).toEqual([]);
    });

    it('strips them from a teacher and says so', () => {
      const access = resolveSourceAccess(['TEACHER'], { grading: true, apiKeys: true });
      if (!access.allowed) throw new Error('expected allowed');
      expect(access.isOwner).toBe(false);
      expect(access.configSelections.apiKeys).toBe(false);
      expect(access.warnings).toEqual([API_KEYS_STRIPPED_WARNING]);
    });

    it('leaves the teacher’s other selections untouched', () => {
      const access = resolveSourceAccess(['TEACHER'], {
        grading: true,
        gradeScales: true,
        features: true,
        apiKeys: true,
      });
      if (!access.allowed) throw new Error('expected allowed');
      expect(access.configSelections).toEqual({
        grading: true,
        gradeScales: true,
        features: true,
        apiKeys: false,
      });
    });

    // The multi-role trap: memberships are unique per (classroom, user, role),
    // so an owner who also holds TEACHER has two rows. Deciding from one
    // arbitrary row would strip keys from a genuine owner.
    it('treats an OWNER+TEACHER as an owner regardless of row order', () => {
      for (const roles of [
        ['OWNER', 'TEACHER'],
        ['TEACHER', 'OWNER'],
      ]) {
        const access = resolveSourceAccess(roles, { apiKeys: true });
        if (!access.allowed) throw new Error('expected allowed');
        expect(access.isOwner).toBe(true);
        expect(access.configSelections.apiKeys).toBe(true);
        expect(access.warnings).toEqual([]);
      }
    });

    it('warns nobody when a teacher never asked for keys', () => {
      const access = resolveSourceAccess(['TEACHER'], { grading: true });
      if (!access.allowed) throw new Error('expected allowed');
      expect(access.warnings).toEqual([]);
      expect(access.configSelections).toEqual({ grading: true });
    });

    it('handles an absent selections object', () => {
      const access = resolveSourceAccess(['TEACHER']);
      if (!access.allowed) throw new Error('expected allowed');
      expect(access.configSelections).toEqual({});
      expect(access.warnings).toEqual([]);
    });
  });

  describe('the returned selections are what gets persisted', () => {
    // This is the assertion that protects the job row. The action writes
    // `access.configSelections` to ImportJob.selections.config, and the retry
    // path reads that row back. A stripped key must be false ON THE ROW, not
    // merely skipped at apply time, or wiring config into retry later would
    // silently resurrect it.
    it('reports apiKeys:false rather than omitting the key', () => {
      const access = resolveSourceAccess(['TEACHER'], { apiKeys: true });
      if (!access.allowed) throw new Error('expected allowed');
      expect('apiKeys' in access.configSelections).toBe(true);
      expect(access.configSelections.apiKeys).toBe(false);
      expect(JSON.stringify(access.configSelections)).toContain('"apiKeys":false');
    });

    it('does not mutate the caller’s object', () => {
      const requested = { grading: true, apiKeys: true };
      resolveSourceAccess(['TEACHER'], requested);
      expect(requested.apiKeys).toBe(true);
    });
  });

  it('exposes exactly the two source roles', () => {
    expect([...SOURCE_ROLES]).toEqual(['OWNER', 'TEACHER']);
  });
});
