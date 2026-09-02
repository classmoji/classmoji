import { Tag } from 'antd';
import { IconFileText, IconPresentation } from '@tabler/icons-react';
import { PageLink } from '~/components/features/pages';

// Draft resources are chipped where they are listed, the way `resourceLeaves`
// already chips a DRAFT form. For slides, `is_draft` is only ever true on the
// teaching-team view, whose loader fetches drafts; a page is chipped by the same
// rule wherever a caller lists one that is draft.
interface LinkedPage {
  page: { id: string; title: string; is_draft?: boolean };
}

interface LinkedSlide {
  slide: { id: string; title: string; is_draft?: boolean };
}

// Rendered inside the link so the chip travels with the item it labels, rather
// than floating loose in the surrounding `gap-4` row.
const DraftTag = () => (
  <Tag color="orange" className="!ms-1 !me-0">
    Draft
  </Tag>
);

interface ResourceLinksProps {
  pages?: LinkedPage[];
  slides?: LinkedSlide[];
  classSlug: string | undefined;
  slidesUrl: string;
  pagesUrl: string;
  rolePrefix?: string;
}

const ResourceLinks = ({
  pages,
  slides,
  classSlug,
  slidesUrl,
  pagesUrl,
  rolePrefix: _rolePrefix = 'student',
}: ResourceLinksProps) => {
  const hasPages = (pages?.length ?? 0) > 0;
  const hasSlides = (slides?.length ?? 0) > 0;

  if (!hasPages && !hasSlides) return null;

  return (
    <div className="flex flex-wrap gap-4 mt-2">
      {hasPages &&
        pages!.map(({ page }: LinkedPage) => (
          <PageLink
            key={page.id}
            pageId={page.id}
            title={page.title}
            href={`${pagesUrl}/${classSlug}/${page.id}`}
            className="flex items-center gap-1 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 text-sm underline"
          >
            <IconFileText size={16} className="text-ink-3" />
            {page.title}
            {page.is_draft === true && <DraftTag />}
          </PageLink>
        ))}
      {hasSlides &&
        slides!.map(({ slide }: LinkedSlide) => (
          <a
            key={slide.id}
            href={`${slidesUrl}/${slide.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 text-sm underline"
          >
            <IconPresentation size={16} className="text-ink-3" />
            {slide.title}
            {slide.is_draft === true && <DraftTag />}
          </a>
        ))}
    </div>
  );
};

export default ResourceLinks;
