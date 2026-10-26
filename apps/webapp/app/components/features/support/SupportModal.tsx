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

interface SupportOption {
  title: string;
  description: string;
  href: string;
  /** mailto links open the user's mail client, so they stay in the same tab. */
  external: boolean;
}

const OPTIONS: SupportOption[] = [
  {
    title: 'Ask a question',
    description: 'Ask on the feedback board. Others may have asked already.',
    href: newPost('question'),
    external: true,
  },
  {
    title: 'Report a bug',
    description: 'Tell us what broke and how to make it happen.',
    href: newPost('bug'),
    external: true,
  },
  {
    title: 'Request a feature',
    description: 'Suggest an idea or upvote one you want.',
    href: newPost('feature'),
    external: true,
  },
  {
    title: 'Email us',
    description: SUPPORT_EMAIL,
    href: `mailto:${SUPPORT_EMAIL}`,
    external: false,
  },
];

/**
 * Support entry point from the sidebar: a question, a bug or a feature request
 * on the feedback board, or plain email. Nothing is sent from here.
 */
const SupportModal = ({ open, onClose }: SupportModalProps) => {
  return (
    <Modal open={open} onCancel={onClose} footer={null} width={520}>
      <div className="pr-6">
        <h2 className="text-lg font-semibold text-ink-0 mb-1">How can we help?</h2>
        <p className="text-sm text-ink-3 mb-5">
          Ask a question, report a bug, or tell us what to build next.
        </p>
      </div>

      <div className="flex flex-col gap-2.5">
        {OPTIONS.map(option => (
          <a
            key={option.title}
            href={option.href}
            {...(option.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            onClick={option.external ? undefined : onClose}
            className="flex items-center justify-between gap-3 rounded-xl ring-1 ring-line px-4 py-3 no-underline hover:bg-nav-hover transition-colors"
          >
            <span className="min-w-0">
              <span className="block font-semibold text-ink-0">{option.title}</span>
              <span className="block text-sm text-ink-3 truncate">{option.description}</span>
            </span>
            {option.external ? (
              <IconExternalLink size={18} strokeWidth={1.75} className="shrink-0 text-ink-3" />
            ) : (
              <IconMail size={18} strokeWidth={1.75} className="shrink-0 text-ink-3" />
            )}
          </a>
        ))}
      </div>
    </Modal>
  );
};

export default SupportModal;
