import { IconFileText, IconPresentation } from '@tabler/icons-react';

interface LinkedPage {
  page: { id: string; title: string };
}

interface LinkedSlide {
  slide: { id: string; title: string };
}

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
  rolePrefix = 'student',
}: ResourceLinksProps) => {
  const hasPages = (pages?.length ?? 0) > 0;
  const hasSlides = (slides?.length ?? 0) > 0;

  if (!hasPages && !hasSlides) return null;

  return (
    <div className="flex flex-wrap gap-4 mt-2">
      {hasPages &&
        pages!.map(({ page }: { page: { id: string; title: string } }) => (
          <a
            key={page.id}
            href={`${pagesUrl}/${classSlug}/${page.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 text-sm underline"
          >
            <IconFileText size={16} className="text-gray-500 dark:text-gray-400" />
            {page.title}
          </a>
        ))}
      {hasSlides &&
        slides!.map(({ slide }: { slide: { id: string; title: string } }) => (
          <a
            key={slide.id}
            href={`${slidesUrl}/${slide.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 text-sm underline"
          >
            <IconPresentation size={16} className="text-gray-500 dark:text-gray-400" />
            {slide.title}
          </a>
        ))}
    </div>
  );
};

export default ResourceLinks;
