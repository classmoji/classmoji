import getPrisma from '@classmoji/database';
import { suggestContentNamespace } from '@classmoji/utils';

/**
 * Pick a free internal content namespace for a new classroom in this org.
 *
 * content_namespace no longer names anything on GitHub (content_repo does), but
 * it keeps a [git_org_id, content_namespace] unique constraint and is no longer
 * user-editable — so a collision has to be resolved silently here instead of
 * being handed back as an error the user has no field to fix. Candidates, in
 * order: the org-prefix-stripped slug, the raw slug (itself globally unique),
 * then numeric suffixes.
 */
export async function pickContentNamespace(gitOrgId: string, orgLogin: string, slug: string) {
  const suggested = suggestContentNamespace({ orgLogin, slug });
  const candidates = [suggested, slug, ...Array.from({ length: 20 }, (_, i) => `${slug}-${i + 2}`)];

  const taken = new Set(
    (
      await getPrisma().classroom.findMany({
        where: { git_org_id: gitOrgId, content_namespace: { in: candidates } },
        select: { content_namespace: true },
      })
    ).map(c => c.content_namespace)
  );

  return candidates.find(c => !taken.has(c)) ?? `${slug}-${Date.now()}`;
}
