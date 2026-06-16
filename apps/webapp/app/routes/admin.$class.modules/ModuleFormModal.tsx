import { Modal, Form, Input, Select, Button } from 'antd';
import { useEffect } from 'react';
import { useFetcher, useParams } from 'react-router';

interface PageOption {
  id: string;
  title: string;
}

export interface ModuleFormModule {
  id: string;
  title: string;
  description?: string | null;
  /** Existing module page links — used to prefill the linked-pages select. */
  pages?: { page_id: string }[];
}

interface ModuleFormModalProps {
  open: boolean;
  /** The module being edited, or null to create a new one. */
  module: ModuleFormModule | null;
  pages: PageOption[];
  onClose: () => void;
}

const ModuleFormModal = ({ open, module, pages, onClose }: ModuleFormModalProps) => {
  const [form] = Form.useForm();
  const fetcher = useFetcher<{ success?: string; error?: string }>();
  const { class: classSlug } = useParams();
  const isEdit = Boolean(module);
  const submitting = fetcher.state !== 'idle';

  // Reset/prefill each time the modal opens (antd only applies initialValues on
  // first mount).
  useEffect(() => {
    if (open) {
      form.setFieldsValue({
        title: module?.title ?? '',
        description: module?.description ?? '',
        linkedPageIds: module?.pages?.map(p => p.page_id) ?? [],
      });
    }
  }, [open, module, form]);

  // Close once the submission succeeds; the fetcher revalidates loaders.
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.success) {
      onClose();
    }
  }, [fetcher.state, fetcher.data, onClose]);

  const handleSubmit = async () => {
    const values = await form.validateFields();
    fetcher.submit(JSON.stringify({ id: module?.id, ...values }), {
      method: 'post',
      action: `/admin/${classSlug}/modules?/${isEdit ? 'update' : 'create'}`,
      encType: 'application/json',
    });
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={isEdit ? 'Edit module' : 'New module'}
      okText={isEdit ? 'Save' : 'Create'}
      footer={[
        <Button key="cancel" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>,
        <Button key="submit" type="primary" loading={submitting} onClick={handleSubmit}>
          {isEdit ? 'Save' : 'Create'}
        </Button>,
      ]}
    >
      <Form form={form} layout="vertical" requiredMark={false} className="mt-4">
        <Form.Item
          name="title"
          label="Title"
          rules={[{ required: true, message: 'A module needs a title' }]}
        >
          <Input placeholder="e.g. Unit 1: Foundations" />
        </Form.Item>
        <Form.Item name="description" label="Description">
          <Input.TextArea rows={3} placeholder="What this module covers (optional)" />
        </Form.Item>
        <Form.Item name="linkedPageIds" label="Linked pages">
          <Select
            mode="multiple"
            allowClear
            placeholder="Attach pages to this module (optional)"
            optionFilterProp="label"
            options={pages.map(p => ({ value: p.id, label: p.title }))}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default ModuleFormModal;
