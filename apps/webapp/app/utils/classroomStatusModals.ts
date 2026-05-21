import { App } from 'antd';

/**
 * Hook returning theme-aware modal openers for classroom status events.
 *
 * Uses antd's <App> context (mounted in root.tsx) so the modal inherits the
 * ConfigProvider theme — static Modal.info bypasses ConfigProvider and renders
 * with antd's default light tokens regardless of dark mode.
 */
export function useClassroomStatusModals() {
  const { modal } = App.useApp();

  const showUnpublished = () => {
    modal.info({
      title: 'Class unavailable',
      content:
        'This class has been unpublished by the owner. Please contact your instructor for details.',
      okText: 'Got it',
    });
  };

  const showLocked = () => {
    modal.info({
      title: 'Read-only mode',
      content:
        'This class is in read-only mode. The owner has locked changes — you can view everything but cannot make edits.',
      okText: 'Got it',
    });
  };

  const showStatusErrorFromResponse = (data: { error?: string } | undefined | null) => {
    if (data?.error === 'CLASSROOM_UNPUBLISHED') return showUnpublished();
    if (data?.error === 'CLASSROOM_LOCKED') return showLocked();
  };

  return { showUnpublished, showLocked, showStatusErrorFromResponse };
}
