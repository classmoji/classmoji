import { useEffect, useState } from 'react';
import { useFetcher } from 'react-router';
import { Modal, Segmented, Select } from 'antd';

import {
  CONTENT_TYPES,
  TYPE_META,
  candidateOptions,
  type CandidateContent,
  type ContentItemType,
  type ModuleItemLike,
} from './moduleItemMeta';

interface AddContentItemModalProps {
  open: boolean;
  onClose: () => void;
  classSlug: string;
  moduleId: string;
  /** What the module already holds, so the picker can leave it out. */
  items: ModuleItemLike[];
  candidates: CandidateContent;
}

/**
 * Place an existing page, slide deck, quiz or form into a module's ordered
 * content list. Posts to the modules action; the loader revalidates.
 */
const AddContentItemModal = ({
  open,
  onClose,
  classSlug,
  moduleId,
  items,
  candidates,
}: AddContentItemModalProps) => {
  const fetcher = useFetcher<{ success?: string; error?: string }>();
  const [type, setType] = useState<ContentItemType>('PAGE');
  const [targetId, setTargetId] = useState<string | undefined>();
  const busy = fetcher.state !== 'idle';

  useEffect(() => {
    if (open) {
      setType('PAGE');
      setTargetId(undefined);
    }
  }, [open]);

  // Close once an add settles successfully.
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.success && open) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const add = () => {
    if (!targetId) return;
    fetcher.submit(JSON.stringify({ moduleId, itemType: type, targetId }), {
      method: 'post',
      action: `/admin/${classSlug}/modules?/addItem`,
      encType: 'application/json',
    });
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="Add item to module"
      okText="Add"
      onOk={add}
      okButtonProps={{ disabled: !targetId }}
      confirmLoading={busy}
      cancelButtonProps={{ disabled: busy }}
    >
      {fetcher.data?.error && (
        <div className="mb-3 text-sm text-rose-600 dark:text-rose-400">{fetcher.data.error}</div>
      )}
      <div className="flex flex-col gap-3 mt-2">
        <Segmented
          block
          value={type}
          onChange={value => {
            setType(value as ContentItemType);
            setTargetId(undefined);
          }}
          options={CONTENT_TYPES.map(t => ({ value: t, label: TYPE_META[t].label }))}
        />
        <Select
          showSearch
          allowClear
          className="w-full"
          placeholder={`Select a ${TYPE_META[type].label.toLowerCase()}…`}
          optionFilterProp="label"
          value={targetId}
          onChange={setTargetId}
          options={candidateOptions(type, candidates, items)}
          notFoundContent="Nothing available to add"
        />
      </div>
    </Modal>
  );
};

export default AddContentItemModal;
