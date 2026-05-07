import { useState } from 'react';
import { Modal, Form, Input, Select, DatePicker, TimePicker, Checkbox, Button, Radio } from 'antd';
import dayjs from 'dayjs';
import {
  IconInfoCircle,
  IconCalendarEvent,
  IconClock,
  IconMapPin,
  IconVideo,
  IconRepeat,
  IconLink,
} from '@tabler/icons-react';
import { getEventTypeDotColor, getEventTypeLabel } from './utils';

const { TextArea } = Input;

const ALL_EVENT_TYPES = ['OFFICE_HOURS', 'LECTURE', 'LAB', 'ASSESSMENT'];

const DAYS_OF_WEEK = [
  { value: 'monday', label: 'Mon' },
  { value: 'tuesday', label: 'Tue' },
  { value: 'wednesday', label: 'Wed' },
  { value: 'thursday', label: 'Thu' },
  { value: 'friday', label: 'Fri' },
  { value: 'saturday', label: 'Sat' },
  { value: 'sunday', label: 'Sun' },
];

interface PageOption {
  id: string;
  title: string;
}

interface SlideOption {
  id: string;
  title: string;
}

interface AssignmentOption {
  id: string;
  title: string;
  module?: { title: string };
}

interface AddEventModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (eventData: Record<string, unknown>) => void | Promise<void>;
  loading?: boolean;
  allowedEventTypes?: string[];
  pages?: PageOption[];
  slides?: SlideOption[];
  assignments?: AssignmentOption[];
}

const InlineRow = ({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ size?: number; className?: string; strokeWidth?: number }>;
  children: React.ReactNode;
}) => (
  <div className="flex items-start gap-3 py-1.5">
    <Icon
      size={18}
      strokeWidth={1.75}
      className="shrink-0 mt-2.5 text-gray-400 dark:text-gray-500"
    />
    <div className="flex-1 min-w-0">{children}</div>
  </div>
);

const AddEventModal = ({
  open,
  onClose,
  onSubmit,
  loading = false,
  allowedEventTypes = ALL_EVENT_TYPES,
  pages = [],
  slides = [],
  assignments = [],
}: AddEventModalProps) => {
  const eventTypes = allowedEventTypes.length > 0 ? allowedEventTypes : ALL_EVENT_TYPES;
  const [form] = Form.useForm();
  const [isRecurring, setIsRecurring] = useState(false);
  const [hasEndDate, setHasEndDate] = useState(false);

  const [linkedPageIds, setLinkedPageIds] = useState<string[]>([]);
  const [linkedSlideIds, setLinkedSlideIds] = useState<string[]>([]);
  const [linkedAssignmentIds, setLinkedAssignmentIds] = useState<string[]>([]);

  const resetAll = () => {
    form.resetFields();
    setIsRecurring(false);
    setHasEndDate(false);
    setLinkedPageIds([]);
    setLinkedSlideIds([]);
    setLinkedAssignmentIds([]);
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();

      const startDate = values.date.toDate();
      const endDate = values.date.toDate();

      const startTime = values.start_time.toDate();
      const endTime = values.end_time.toDate();

      startDate.setHours(startTime.getHours(), startTime.getMinutes(), 0, 0);
      endDate.setHours(endTime.getHours(), endTime.getMinutes(), 0, 0);

      const eventData = {
        event_type: values.event_type,
        title: values.title,
        description: values.description || null,
        start_time: startDate.toISOString(),
        end_time: endDate.toISOString(),
        location: values.location || null,
        meeting_link: values.meeting_link || null,
        is_recurring: isRecurring,
        recurrence_rule: isRecurring
          ? {
              days: values.recurrence_days || [],
              until:
                hasEndDate && values.recurrence_until
                  ? values.recurrence_until.toDate().toISOString()
                  : null,
            }
          : null,
        ...(isRecurring
          ? {}
          : {
              linkedPageIds,
              linkedSlideIds,
              linkedAssignmentIds,
            }),
      };

      await onSubmit(eventData);
      resetAll();
    } catch (error: unknown) {
      console.error('Form validation failed:', error);
    }
  };

  const handleCancel = () => {
    resetAll();
    onClose();
  };

  const hasLinks = pages.length > 0 || slides.length > 0 || assignments.length > 0;

  return (
    <Modal
      open={open}
      onCancel={handleCancel}
      title={null}
      footer={null}
      width={560}
      centered
      closable={false}
      maskClosable
      styles={{
        content: { padding: 0, borderRadius: 16, overflow: 'hidden' },
        body: { padding: 0 },
        header: { display: 'none' },
        footer: { display: 'none' },
      }}
    >
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={{
          event_type: eventTypes[0] ?? 'OFFICE_HOURS',
          date: dayjs(),
          start_time: dayjs(),
          end_time: dayjs().add(1, 'hour'),
        }}
      >
        {/* Gmail-style header */}
        <div className="flex items-center justify-between gap-3 px-5 py-3 bg-stone-50 dark:bg-neutral-800/60 border-b border-stone-200 dark:border-neutral-800">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">New event</span>
          <button
            type="button"
            onClick={handleCancel}
            aria-label="Close"
            className="p-1 rounded hover:bg-stone-200 dark:hover:bg-neutral-700 text-gray-500 dark:text-gray-400 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 pt-4 pb-2 max-h-[70vh] overflow-y-auto">
          {/* Big title field — Gmail "Subject" style */}
          <Form.Item
            name="title"
            rules={[{ required: true, message: 'Please enter a title' }]}
            className="!mb-3"
          >
            <Input
              variant="borderless"
              placeholder="Add title"
              className="!text-lg !font-semibold !px-0"
              style={{ paddingLeft: 0, paddingRight: 0 }}
            />
          </Form.Item>

          <div className="h-px bg-stone-200 dark:bg-neutral-800" />

          <InlineRow icon={IconCalendarEvent}>
            <Form.Item
              name="event_type"
              rules={[{ required: true, message: 'Please select an event type' }]}
              className="!mb-0"
            >
              <Select
                variant="borderless"
                disabled={eventTypes.length === 1}
                options={eventTypes.map(type => ({
                  value: type,
                  label: (
                    <span className="inline-flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${getEventTypeDotColor(type)}`} />
                      {getEventTypeLabel(type)}
                    </span>
                  ),
                }))}
              />
            </Form.Item>
          </InlineRow>

          <InlineRow icon={IconClock}>
            <div className="grid grid-cols-[1fr_auto_auto] gap-2 items-center">
              <Form.Item
                name="date"
                rules={[{ required: true, message: 'Required' }]}
                className="!mb-0"
              >
                <DatePicker variant="borderless" className="w-full" />
              </Form.Item>
              <Form.Item
                name="start_time"
                rules={[{ required: true, message: 'Required' }]}
                className="!mb-0"
              >
                <TimePicker variant="borderless" format="h:mm A" use12Hours className="w-28" />
              </Form.Item>
              <Form.Item
                name="end_time"
                rules={[{ required: true, message: 'Required' }]}
                className="!mb-0"
              >
                <TimePicker variant="borderless" format="h:mm A" use12Hours className="w-28" />
              </Form.Item>
            </div>
          </InlineRow>

          <InlineRow icon={IconRepeat}>
            <Checkbox
              checked={isRecurring}
              onChange={e => setIsRecurring(e.target.checked)}
              className="!mt-2"
            >
              <span className="text-sm">Repeat</span>
            </Checkbox>
            {isRecurring && (
              <div className="mt-2 rounded-lg bg-stone-50 dark:bg-neutral-800/40 border border-stone-200 dark:border-neutral-800 px-3 py-3 space-y-3">
                <Form.Item
                  name="recurrence_days"
                  label="Repeat on"
                  rules={[{ required: true, message: 'Please select at least one day' }]}
                  className="!mb-0"
                >
                  <Checkbox.Group options={DAYS_OF_WEEK} />
                </Form.Item>
                <div>
                  <div className="text-[14px] mb-2 text-gray-700 dark:text-gray-300">Ends</div>
                  <Radio.Group
                    value={hasEndDate ? 'on' : 'never'}
                    onChange={e => setHasEndDate(e.target.value === 'on')}
                    className="flex gap-4"
                  >
                    <Radio value="never">Never</Radio>
                    <Radio value="on">On date</Radio>
                  </Radio.Group>
                  {hasEndDate && (
                    <Form.Item
                      name="recurrence_until"
                      rules={[{ required: true, message: 'Please select an end date' }]}
                      className="!mb-0 !mt-2"
                    >
                      <DatePicker className="w-full" />
                    </Form.Item>
                  )}
                </div>
              </div>
            )}
          </InlineRow>

          <InlineRow icon={IconMapPin}>
            <Form.Item name="location" className="!mb-0 !mt-1">
              <Input variant="borderless" placeholder="Add location" className="!px-0" />
            </Form.Item>
          </InlineRow>

          <InlineRow icon={IconVideo}>
            <Form.Item name="meeting_link" className="!mb-0 !mt-1">
              <Input variant="borderless" placeholder="Add meeting link" className="!px-0" />
            </Form.Item>
          </InlineRow>

          <InlineRow icon={IconInfoCircle}>
            <Form.Item name="description" className="!mb-0 !mt-1">
              <TextArea
                variant="borderless"
                autoSize={{ minRows: 1, maxRows: 4 }}
                placeholder="Add description"
                className="!px-0"
              />
            </Form.Item>
          </InlineRow>

          {hasLinks && (
            <>
              <div className="h-px bg-stone-200 dark:bg-neutral-800 my-2" />

              <InlineRow icon={IconLink}>
                {isRecurring ? (
                  <div className="flex items-start gap-2 rounded-lg bg-[#FEF3EC] dark:bg-amber-900/20 border border-[#F4D8C5] dark:border-amber-800/40 px-3 py-2 text-xs text-[#8a5b3a] dark:text-amber-200">
                    <IconInfoCircle size={14} className="shrink-0 mt-0.5" />
                    <div>
                      For recurring events, link resources to individual dates after creation.
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {pages.length > 0 && (
                      <Select
                        mode="multiple"
                        placeholder="Link pages"
                        value={linkedPageIds}
                        onChange={setLinkedPageIds}
                        options={pages.map(p => ({ value: p.id, label: p.title }))}
                        optionFilterProp="label"
                        allowClear
                        className="w-full"
                      />
                    )}
                    {slides.length > 0 && (
                      <Select
                        mode="multiple"
                        placeholder="Link slide decks"
                        value={linkedSlideIds}
                        onChange={setLinkedSlideIds}
                        options={slides.map(s => ({ value: s.id, label: s.title }))}
                        optionFilterProp="label"
                        allowClear
                        className="w-full"
                      />
                    )}
                    {assignments.length > 0 && (
                      <Select
                        mode="multiple"
                        placeholder="Link assignments"
                        value={linkedAssignmentIds}
                        onChange={setLinkedAssignmentIds}
                        options={assignments.map(a => ({
                          value: a.id,
                          label: a.module?.title ? `${a.module.title}: ${a.title}` : a.title,
                        }))}
                        optionFilterProp="label"
                        allowClear
                        className="w-full"
                      />
                    )}
                  </div>
                )}
              </InlineRow>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-neutral-800 bg-stone-50/60 dark:bg-neutral-800/40">
          <Button onClick={handleCancel} type="text">
            Discard
          </Button>
          <Button
            type="primary"
            loading={loading}
            onClick={handleSubmit}
            style={{ backgroundColor: '#619462', borderColor: '#619462' }}
          >
            Save
          </Button>
        </div>
      </Form>
    </Modal>
  );
};

export default AddEventModal;
