/**
 * A markdown import's uploads as the files `page.createPage` commits with the
 * page, placed where the conversion said (`pageImport.convertMarkdown`, run on
 * Trigger.dev, which saw the uploads' names only).
 *
 * Shared by both import actions (`admin.$class.pages.new`, `api.pages.batch`).
 * Every image reference the markdown matched is committed at the path the
 * conversion chose (the page's HTML already points there); every upload no
 * reference matched is committed too, under `<contentPath>/assets/`.
 */
import type { MarkdownConversion } from '@classmoji/services';

export type PageImportFile = { path: string; content: string; encoding: 'utf-8' | 'base64' };

/** `name.ext` -> `name-<timestamp>.ext`, lower-cased and dash-safe. */
function timestampedName(name: string): string {
  const timestamp = Date.now();
  const sanitizedName = name
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '-')
    .replace(/-+/g, '-');
  return `${sanitizedName.split('.')[0]}-${timestamp}.${sanitizedName.split('.').pop()}`;
}

export async function markdownImportFiles(
  conversion: Pick<MarkdownConversion, 'images' | 'unmatched'>,
  uploads: File[],
  contentPath: string
): Promise<PageImportFile[]> {
  const placed: Array<{ path: string; file: File }> = [
    ...conversion.images.map(image => ({ path: image.newPath, file: uploads[image.index] })),
    ...conversion.unmatched.map(index => ({
      path: `${contentPath}/assets/${timestampedName(uploads[index].name)}`,
      file: uploads[index],
    })),
  ];
  return Promise.all(
    placed.map(async ({ path, file }) => ({
      path,
      content: Buffer.from(await file.arrayBuffer()).toString('base64'),
      encoding: 'base64' as const,
    }))
  );
}
