import { IconBook, IconFile, IconFileText, IconHelp } from '@tabler/icons-react';
import { buildContentReferenceUrl } from '~/utils/contentReferenceUrl';

export interface ContentReference {
  referenceType: string;
  contentPath: string;
  displayText: string;
  [key: string]: unknown;
}

interface ContentReferenceChipsProps {
  references: ContentReference[];
  classroomSlug: string;
  slidesUrl: string;
  pagesUrl: string;
}

const iconFor = (type: string) => {
  switch (type) {
    case 'page':
      return <IconFileText size={13} />;
    case 'slides':
      return <IconBook size={13} />;
    case 'platform_docs':
      return <IconHelp size={13} />;
    default:
      return <IconFile size={13} />;
  }
};

/**
 * The citation chips under an assistant answer.
 *
 * Lifted out of `SyllabusBotChat` so the ONE rule that matters here can be
 * asserted against rendered markup rather than against a regex over the chat
 * component's source. It is presentational and stateless: what it draws depends
 * only on its props.
 *
 * ── A REFERENCE WITH NO URL IS A LABEL, NOT A LINK ─────────────────────────
 * `buildContentReferenceUrl` returns null when it cannot build a link — an
 * unknown reference type, a malformed docs slug, a page whose app URL was never
 * passed in. This used to render `href={url || '#'}`, which is a clickable dead
 * link: focusable, announced as a link, styled exactly like a working chip, and
 * it navigates the page to itself.
 *
 * So the null case is a `<span>`. Same class, so it looks identical in both
 * themes (the chip's colours come from panel-level CSS variables); no `href`,
 * no `tabIndex` and no `role`, so it is not in the tab order and nothing about
 * it says "activate me".
 */
export default function ContentReferenceChips({
  references,
  classroomSlug,
  slidesUrl,
  pagesUrl,
}: ContentReferenceChipsProps) {
  if (!references || references.length === 0) return null;

  return (
    <div className="askmoji-refs">
      {references.map((ref, idx) => {
        const url = buildContentReferenceUrl(ref, classroomSlug, slidesUrl, pagesUrl);

        if (!url) {
          return (
            <span key={idx} className="askmoji-ref">
              {iconFor(ref.referenceType)}
              {ref.displayText}
            </span>
          );
        }

        return (
          <a key={idx} href={url} target="_blank" rel="noopener noreferrer" className="askmoji-ref">
            {iconFor(ref.referenceType)}
            {ref.displayText}
          </a>
        );
      })}
    </div>
  );
}
