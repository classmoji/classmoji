import { Modal } from 'antd';
import { IconExternalLink, IconMail } from '@tabler/icons-react';

const DISCUSSIONS_URL = 'https://github.com/classmoji/classmoji/discussions';
// Opens the guided bug form (.github/ISSUE_TEMPLATE/bug_report.yml) rather than
// a blank issue, so reports arrive with repro steps and the `bug` label.
const ISSUES_URL = 'https://github.com/classmoji/classmoji/issues/new?template=bug_report.yml';
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
    description: 'Get help from the community.',
    href: DISCUSSIONS_URL,
    external: true,
  },
  {
    title: 'Report a bug',
    description: 'Found a bug or have a feature request?',
    href: ISSUES_URL,
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
 * Support entry point from the sidebar. Three ways to reach us: community
 * discussions, a Github issue, or plain email. Nothing is sent from here.
 */
const SupportModal = ({ open, onClose }: SupportModalProps) => {
  return (
    <Modal open={open} onCancel={onClose} footer={null} width={520}>
      <div className="pr-6">
        <h2 className="text-lg font-semibold text-ink-0 mb-1">Help &amp; Feedback</h2>
        <p className="text-sm text-ink-3 mb-5">
          Questions, bugs, or anything else. Pick whichever is easiest.
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
