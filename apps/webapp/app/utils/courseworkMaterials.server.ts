import type { LinkedMaterial } from '@classmoji/services';
import type { CourseworkMaterial } from '~/components/features/assignments/CourseworkMaterials';

/**
 * Where each linked page and deck opens, built the way the Modules page builds
 * its links (`buildResourceLeaves`): a page in the pages app under the
 * classroom, a deck in the slides app. Every coursework screen that lists them
 * (the dashboard's Up next, the Assignments page) links through here.
 */
export const courseworkMaterials = (
  materials: LinkedMaterial[] | undefined,
  classSlug: string
): CourseworkMaterial[] => {
  const pagesUrl = process.env.PAGES_URL || 'http://localhost:7100';
  const slidesUrl = process.env.SLIDES_URL || 'http://localhost:6500';
  return (materials ?? []).map(m => ({
    ...m,
    href: m.kind === 'PAGE' ? `${pagesUrl}/${classSlug}/${m.id}` : `${slidesUrl}/${m.id}`,
  }));
};
