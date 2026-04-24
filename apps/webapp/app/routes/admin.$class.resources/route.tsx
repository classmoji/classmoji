import { Modal } from 'antd';
import { useNavigate } from 'react-router';
import ResourcesKanban from './ResourcesKanban';
import type { Route } from './+types/route';

export { loader } from './loader';
export { action } from './action';

export default function ResourcesPage({ loaderData }: Route.ComponentProps) {
  const { modules, pages, slides } = loaderData;
  const navigate = useNavigate();

  const handleClose = () => {
    navigate(-1);
  };

  return (
    <Modal
      open={true}
      onCancel={handleClose}
      title={null}
      footer={null}
      closable={false}
      maskClosable
      centered
      width="calc(100vw - 3rem)"
      styles={{
        mask: { backgroundColor: 'rgba(15, 23, 42, 0.45)' },
        content: {
          padding: 0,
          borderRadius: 16,
          overflow: 'hidden',
          height: 'calc(100vh - 3rem)',
          display: 'flex',
          flexDirection: 'column',
          boxShadow:
            '0 32px 64px -16px rgba(15, 23, 42, 0.35), 0 0 0 1px rgba(0, 0, 0, 0.04)',
        },
        body: {
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
          background: '#F6F7FB',
        },
        header: { display: 'none' },
      }}
    >
      {/* Gmail-style header */}
      <div className="flex items-center justify-between gap-3 px-6 py-3 bg-stone-50 dark:bg-neutral-800/60 border-b border-stone-200 dark:border-neutral-800 shrink-0">
        <div className="flex flex-col">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Link resources
          </span>
          <span className="text-[11px] font-normal text-gray-500 dark:text-gray-400">
            Drag pages and slide decks onto modules or assignments to link them.
          </span>
        </div>
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close"
          className="p-1.5 rounded hover:bg-stone-200 dark:hover:bg-neutral-700 text-gray-500 dark:text-gray-400 transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        <ResourcesKanban modules={modules} pages={pages} slides={slides} />
      </div>
    </Modal>
  );
}
