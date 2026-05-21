import { Modal } from 'antd';

export function showUnpublishedModal() {
  Modal.info({
    title: 'Class unavailable',
    content:
      'This class has been unpublished by the owner. Please contact your instructor for details.',
    okText: 'Got it',
  });
}

export function showLockedModal() {
  Modal.info({
    title: 'Read-only mode',
    content:
      'This class is in read-only mode. The owner has locked changes — you can view everything but cannot make edits.',
    okText: 'Got it',
  });
}

export function showStatusErrorFromResponse(data: { error?: string } | undefined | null) {
  if (data?.error === 'CLASSROOM_UNPUBLISHED') return showUnpublishedModal();
  if (data?.error === 'CLASSROOM_LOCKED') return showLockedModal();
}
