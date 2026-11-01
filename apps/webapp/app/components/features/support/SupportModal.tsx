import { Modal } from 'antd';
import { IconExternalLink, IconMail } from '@tabler/icons-react';

// The feedback board, opened in a new tab so the classroom stays open, with the
// new-post form already set to the right type. Questions and bugs live there
// too: teachers do not use Github, so nothing here sends them to it.
const newPost = (type: 'question' | 'bug' | 'feature') => `/feedback?new=${type}`;
export const SUPPORT_EMAIL = 'hello@classmoji.io';

interface SupportModalProps {
  open: boolean;
  onClose: () => void;
}

/** Everything on the board is public; email reaches only the team. */
const BOARD_OPTIONS = [
  { title: 'Browse feedback & roadmap', href: '/feedback' },
  { title: 'Report a bug', href: newPost('bug') },
  { title: 'Request a feature', href: newPost('feature') },
  { title: 'Ask about Classmoji', href: newPost('question') },
];

const optionClass =
  'flex items-center justify-between gap-3 rounded-xl ring-1 ring-line px-4 py-3 no-underline hover:bg-nav-hover transition-colors';

const GroupTitle = ({ label, chip, tone }: { label: string; chip: string; tone: string }) => (
  <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
    {label}
    <span className={`rounded-full px-2 py-0.5 text-[11px] normal-case tracking-normal ${tone}`}>
      {chip}
    </span>
  </div>
);

/**
 * Support entry point from the sidebar: the public feedback board (browse, a
 * bug, a feature request, a question), or private email. Nothing is sent from
 * here.
 */
const SupportModal = ({ open, onClose }: SupportModalProps) => {
  return (
    <Modal open={open} onCancel={onClose} footer={null} width={520}>
      <h2 className="mb-5 pr-6 text-lg font-semibold text-ink-0">How can we help?</h2>

      <GroupTitle label="Feedback board" chip="Public" tone="bg-sky-bg text-sky-ink" />
      <div className="flex flex-col gap-2">
        {BOARD_OPTIONS.map(option => (
          <a
            key={option.title}
            href={option.href}
            target="_blank"
            rel="noopener noreferrer"
            className={optionClass}
          >
            <span className="font-semibold text-ink-0">{option.title}</span>
            <IconExternalLink size={18} strokeWidth={1.75} className="shrink-0 text-ink-3" />
          </a>
        ))}
      </div>

      <div className="mt-5">
        <GroupTitle
          label="Private support"
          chip="Only our team"
          tone="bg-stone-100 text-ink-2 dark:bg-neutral-800"
        />
        {/* mailto opens the mail client, so it stays in this tab. */}
        <a href={`mailto:${SUPPORT_EMAIL}`} onClick={onClose} className={optionClass}>
          <span className="font-semibold text-ink-0">Email us</span>
          <IconMail size={18} strokeWidth={1.75} className="shrink-0 text-ink-3" />
        </a>
      </div>
    </Modal>
  );
};

export default SupportModal;
