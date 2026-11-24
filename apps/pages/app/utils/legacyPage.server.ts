import { ContentService } from '@classmoji/services';

import { prisma } from './db.server.ts';

/**
 * Whether git holds this page as a legacy page (`index.html`, no
 * `content.json`), asked when the loader's own content came from the live
 * room (which holds collab's converted blocks either way) and so says nothing
 * about what readers get.
 *
 * The asset map first (one indexed read; every save and checkpoint records
 * `content.json` there): a `content.json` row means no, an `index.html` row
 * alone means yes. When the map has neither, git is asked. A failure answers
 * false: this decides a staff notice only, never what is shown or written.
 *
 * `deps` is for tests.
 */
export async function pageIsLegacyInGit(
  page: {
    content_path: string;
    classroom: {
      id: string;
      content_repo: string | null;
      git_organization?: { provider: string; login: string; [key: string]: unknown } | null;
    };
  },
  deps: {
    mapPaths?: (classroomId: string, paths: string[]) => Promise<string[]>;
    exists?: (path: string) => Promise<boolean>;
  } = {}
): Promise<boolean> {
  const json = `${page.content_path}/content.json`;
  const html = `${page.content_path}/index.html`;
  const mapPaths =
    deps.mapPaths ??
    (async (classroomId: string, paths: string[]) =>
      (
        await prisma.contentAsset.findMany({
          where: { classroom_id: classroomId, path: { in: paths } },
          select: { path: true },
        })
      ).map(row => row.path));
  const exists =
    deps.exists ??
    ((path: string) => {
      const { content_repo: repo, git_organization: gitOrganization } = page.classroom;
      if (!repo || !gitOrganization) return Promise.resolve(false);
      return ContentService.exists({ gitOrganization: gitOrganization as never, repo, path });
    });
  try {
    const known = new Set(await mapPaths(page.classroom.id, [json, html]));
    if (known.has(json)) return false;
    if (known.has(html)) return true;
    if (await exists(json)) return false;
    return await exists(html);
  } catch (error) {
    console.warn('[pages] could not tell whether the page is legacy in git:', error);
    return false;
  }
}
