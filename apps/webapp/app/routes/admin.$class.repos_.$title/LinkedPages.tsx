import { Tag } from 'antd';
import dayjs from 'dayjs';
import { IconBook, IconArrowRight } from '@tabler/icons-react';
import { useNavigate } from 'react-router';

export interface LinkedPage {
  id: string;
  pageId: string;
  title: string;
  linkedTo: string;
  isDraft: boolean;
  updatedAt: string | Date;
}

interface LinkedPagesProps {
  classSlug?: string;
  pages: LinkedPage[];
}

const LinkedPages = ({ classSlug, pages }: LinkedPagesProps) => {
  const navigate = useNavigate();
  if (!pages.length) return null;

  const goToPages = () => navigate(`/admin/${classSlug}/pages`);

  return (
    <div className="mt-6 rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 p-5 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <IconBook size={18} className="text-sky-500" />
          <span className="font-semibold text-ink-1">Linked pages</span>
          <span className="text-ink-3 text-sm">
            {pages.length} page{pages.length !== 1 ? 's' : ''}
          </span>
        </div>
        <button
          type="button"
          onClick={goToPages}
          className="flex items-center gap-1 text-sm font-medium text-ink-2 hover:text-ink-1 rounded-lg ring-1 ring-stone-200 dark:ring-neutral-700 px-3 py-1.5"
        >
          <IconArrowRight size={15} /> Go to Pages
        </button>
      </div>

      <div className="divide-y divide-stone-100 dark:divide-neutral-800">
        {pages.map(p => (
          <div key={p.id} className="flex items-center justify-between py-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="shrink-0 w-9 h-9 rounded-lg bg-sky-50 dark:bg-sky-950/40 flex items-center justify-center">
                <IconBook size={16} className="text-sky-500" />
              </div>
              <div className="min-w-0">
                <div className="font-medium text-ink-1 truncate">{p.title}</div>
                <div className="text-xs text-ink-3 truncate">
                  {p.linkedTo} · updated {dayjs(p.updatedAt).format('M/D/YYYY')}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <Tag color={p.isDraft ? 'orange' : 'green'} className="font-semibold m-0">
                {p.isDraft ? 'Draft' : 'Published'}
              </Tag>
              <button
                type="button"
                onClick={() => navigate(`/admin/${classSlug}/pages/${p.pageId}`)}
                className="flex items-center gap-1 text-sm font-medium text-sky-600 hover:text-sky-700 dark:text-sky-400"
              >
                Open <IconArrowRight size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default LinkedPages;
