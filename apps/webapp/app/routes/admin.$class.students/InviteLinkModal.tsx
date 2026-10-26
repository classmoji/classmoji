import { useEffect, useState } from 'react';
import { useFetcher } from 'react-router';
import { Button, Input, Modal, Popconfirm, Switch } from 'antd';

export interface JoinLinkState {
  enabled: boolean;
  code: string | null;
}

/**
 * The owner's control for the shareable invite link: on/off, copy, reset.
 * Posts to this route's `updateJoinLink` action, which writes the audit row.
 */
const InviteLinkModal = ({
  open,
  onClose,
  joinLink,
  isGitLab,
}: {
  open: boolean;
  onClose: () => void;
  joinLink: JoinLinkState;
  isGitLab: boolean;
}) => {
  // Its own fetcher: the global one would toast every response.
  const fetcher = useFetcher<{ joinLink?: JoinLinkState; error?: string }>();
  const [copied, setCopied] = useState(false);
  const state = fetcher.data?.joinLink ?? joinLink;
  const busy = fetcher.state !== 'idle';
  const url =
    state.code && typeof window !== 'undefined'
      ? `${window.location.origin}/join/${state.code}`
      : '';

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const update = (body: { enabled?: boolean; reset?: boolean }) =>
    fetcher.submit(body, {
      method: 'post',
      action: '?/updateJoinLink',
      encType: 'application/json',
    });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard refused (permissions or http): the field is selectable.
    }
  };

  const platform = isGitLab ? 'Gitlab' : 'Github';

  return (
    <Modal open={open} onCancel={onClose} footer={null} title="Invite link" width={480}>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Share one link with the whole class. Students sign in with {platform} and join right away;
        {isGitLab
          ? ' their repositories are created as they join.'
          : ' Github then asks them to accept the class organization in the same tab.'}{' '}
        No roster needed: students on a roster you pasted are matched to it by their verified email.
      </p>

      <label className="mt-5 flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
          Anyone with the link can join
        </span>
        <Switch checked={state.enabled} loading={busy} onChange={enabled => update({ enabled })} />
      </label>

      {state.enabled && url && (
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex gap-2">
            <Input readOnly value={url} onFocus={e => e.target.select()} aria-label="Invite link" />
            <Button type="primary" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Shared it somewhere it should not be? Reset it: the old link stops working.
            </span>
            <Popconfirm
              title="Reset the invite link?"
              description="The current link stops working right away."
              okText="Reset"
              okButtonProps={{ danger: true }}
              onConfirm={() => update({ reset: true })}
            >
              <Button size="small" disabled={busy}>
                Reset link
              </Button>
            </Popconfirm>
          </div>
        </div>
      )}

      {fetcher.data?.error && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">{fetcher.data.error}</p>
      )}
    </Modal>
  );
};

export default InviteLinkModal;
