import { Link } from 'react-router';
import { Modal } from 'antd';

/**
 * Shown in place of a "new page" or "new slide" form when the class is already
 * at its Free plan limit, so nobody fills in a form only to be refused at the
 * end. The create action still refuses on its own; this is the early notice.
 */
const ContentLimitModal = ({
  open,
  message,
  canUpgrade,
  onClose,
}: {
  open: boolean;
  /** The plan limit's sentence (`contentLimitMessage`), from the loader. */
  message: string;
  /** Owners can upgrade; other staff are told who can. */
  canUpgrade: boolean;
  onClose: () => void;
}) => (
  <Modal open={open} onCancel={onClose} footer={null} title="Free plan limit reached" centered>
    <p className="text-sm text-ink-2 mb-5">{message}</p>
    <div className="flex items-center justify-end gap-2">
      {!canUpgrade && (
        <span className="mr-auto text-sm text-ink-3">Ask the class owner to upgrade.</span>
      )}
      <button type="button" className="btn" onClick={onClose}>
        {canUpgrade ? 'Not now' : 'OK'}
      </button>
      {canUpgrade && (
        <Link to="/settings/billing" className="btn btn-primary">
          Upgrade to Pro
        </Link>
      )}
    </div>
  </Modal>
);

export default ContentLimitModal;
