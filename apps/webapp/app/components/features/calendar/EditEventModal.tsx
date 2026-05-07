import { useState, useEffect } from 'react';
import {
  Modal,
  Form,
  Input,
  Select,
  DatePicker,
  TimePicker,
  Checkbox,
  Button,
  Space,
  Radio,
} from 'antd';
import {
  IconInfoCircle,
  IconCalendarEvent,
  IconClock,
  IconMapPin,
  IconVideo,
  IconRepeat,
  IconLink,
  IconTrash,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import { getEventTypeDotColor, getEventTypeLabel } from './utils';
import EventLinks from './EventLinks';

const { TextArea } = Input;

const isSameDateDay = (date1: string | Date, date2: string | Date) => {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return (
    d1.getUTCFullYear() === d2.getUTCFullYear() &&
    d1.getUTCMonth() === d2.getUTCMonth() &&
    d1.getUTCDate() === d2.getUTCDate()
  );
};

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

const EDIT_SCOPES = {
  THIS_ONLY: 'this_only',
  THIS_AND_FUTURE: 'this_and_future',
  ALL: 'all',
};

interface CalendarEvent {
  id: string;
  event_type: string;
  title: string;
  description?: string | null;
  start_time: string;
  end_time: string;
  location?: string | null;
  meeting_link?: string | null;
  is_recurring?: boolean;
  occurrence_date?: string | null;
  recurrence_rule?: { days?: string[]; until?: string | null } | null;
  _rawPageLinks?: Array<{ page_id: string; occurrence_date?: string | null }>;
  _rawSlideLinks?: Array<{ slide_id: string; occurrence_date?: string | null }>;
  _rawAssignmentLinks?: Array<{ assignment_id: string; occurrence_date?: string | null }>;
  [key: string]: unknown;
}

interface CalendarResource {
  id: string;
  title: string;
}

interface CalendarAssignment {
  id: string;
  title: string;
  module?: { title: string };
}

interface EventFormValues {
  event_type: string;
  title: string;
  description?: string;
  date: dayjs.Dayjs;
  start_time: dayjs.Dayjs;
  end_time: dayjs.Dayjs;
  location?: string;
  meeting_link?: string;
  recurrence_days?: string[];
  recurrence_until?: dayjs.Dayjs | null;
}

interface EventFormData {
  event_type: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string;
  location: string | null;
  meeting_link: string | null;
  is_recurring: boolean;
  recurrence_rule: { days: string[]; until: string | null } | null;
  linkedPageIds?: string[];
  linkedSlideIds?: string[];
  linkedAssignmentIds?: string[];
}

interface EditEventModalProps {
  open: boolean;
  event: CalendarEvent | null;
  onClose: () => void;
  onSubmit: (data: EventFormData) => Promise<void>;
  onDelete: (id: string, opts?: Record<string, unknown>) => Promise<void>;
  loading?: boolean;
  allowedEventTypes?: string[];
  classSlug: string;
  rolePrefix?: string;
  slidesUrl?: string;
  pagesUrl?: string;
  pages?: CalendarResource[];
  slides?: CalendarResource[];
  assignments?: CalendarAssignment[];
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

const EditEventModal = ({
  open,
  event,
  onClose,
  onSubmit,
  onDelete,
  loading = false,
  allowedEventTypes = ALL_EVENT_TYPES,
  classSlug,
  rolePrefix = 'assistant',
  slidesUrl,
  pagesUrl = 'http://localhost:7100',
  pages = [],
  slides = [],
  assignments = [],
}: EditEventModalProps) => {
  const eventTypes = allowedEventTypes.length > 0 ? allowedEventTypes : ALL_EVENT_TYPES;
  const [form] = Form.useForm();
  const [isRecurring, setIsRecurring] = useState(false);
  const [hasEndDate, setHasEndDate] = useState(false);
  const [editScope, setEditScope] = useState(EDIT_SCOPES.THIS_ONLY);
  const [showScopeModal, setShowScopeModal] = useState(false);
  const [scopeAction, setScopeAction] = useState<'edit' | 'delete' | null>(null);
  const [pendingFormData, setPendingFormData] = useState<EventFormData | null>(null);

  const [linkedPageIds, setLinkedPageIds] = useState<string[]>([]);
  const [linkedSlideIds, setLinkedSlideIds] = useState<string[]>([]);
  const [linkedAssignmentIds, setLinkedAssignmentIds] = useState<string[]>([]);

  const isRecurringOccurrence = event?.is_recurring && event?.occurrence_date;

  useEffect(() => {
    if (event) {
      const startDate = dayjs(event.start_time);
      const endDate = dayjs(event.end_time);

      setIsRecurring(event.is_recurring || false);
      setHasEndDate(!!event.recurrence_rule?.until);
      setEditScope(EDIT_SCOPES.THIS_ONLY);

      form.setFieldsValue({
        event_type: event.event_type,
        title: event.title,
        description: event.description,
        date: startDate,
        start_time: startDate,
        end_time: endDate,
        location: event.location,
        meeting_link: event.meeting_link,
        recurrence_days: event.recurrence_rule?.days || [],
        recurrence_until: event.recurrence_rule?.until ? dayjs(event.recurrence_rule.until) : null,
      });

      const occurrenceDate = event.occurrence_date || event.start_time;
      const filterLinksForOccurrence = <T extends { occurrence_date?: string | null }>(
        links: T[] | undefined
      ) => {
        if (!links) return [];
        return links.filter(
          link => !link.occurrence_date || isSameDateDay(link.occurrence_date, occurrenceDate)
        );
      };

      const pageLinks = filterLinksForOccurrence(event._rawPageLinks);
      const slideLinks = filterLinksForOccurrence(event._rawSlideLinks);
      const assignmentLinks = filterLinksForOccurrence(event._rawAssignmentLinks);

      setLinkedPageIds(pageLinks.map(l => l.page_id));
      setLinkedSlideIds(slideLinks.map(l => l.slide_id));
      setLinkedAssignmentIds(assignmentLinks.map(l => l.assignment_id));
    }
  }, [event, form]);

  const buildEventData = (values: EventFormValues, includeLinks = true) => {
    const startDate = values.date.toDate();
    const endDate = values.date.toDate();

    const startTime = values.start_time.toDate();
    const endTime = values.end_time.toDate();

    startDate.setHours(startTime.getHours(), startTime.getMinutes(), 0, 0);
    endDate.setHours(endTime.getHours(), endTime.getMinutes(), 0, 0);

    const eventData: EventFormData = {
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
    };

    if (includeLinks) {
      eventData.linkedPageIds = linkedPageIds;
      eventData.linkedSlideIds = linkedSlideIds;
      eventData.linkedAssignmentIds = linkedAssignmentIds;
    }

    return eventData;
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const eventData = buildEventData(values);

      if (isRecurringOccurrence) {
        setPendingFormData(eventData);
        setScopeAction('edit');
        setShowScopeModal(true);
        return;
      }

      await onSubmit(eventData);
    } catch (error: unknown) {
      console.error('Form validation failed:', error);
    }
  };

  const handleScopeConfirm = async () => {
    if (!event) return;
    if (scopeAction === 'edit' && pendingFormData) {
      const includeLinks = editScope === EDIT_SCOPES.THIS_ONLY;
      const dataToSubmit = includeLinks
        ? {
            ...pendingFormData,
            linkedPageIds,
            linkedSlideIds,
            linkedAssignmentIds,
            editScope,
            occurrenceDate: event.occurrence_date
              ? new Date(event.occurrence_date).toISOString()
              : null,
          }
        : {
            ...pendingFormData,
            editScope,
            occurrenceDate: event.occurrence_date
              ? new Date(event.occurrence_date).toISOString()
              : null,
          };
      await onSubmit(dataToSubmit);
    } else if (scopeAction === 'delete') {
      await onDelete(event.id, {
        editScope,
        occurrenceDate: event.occurrence_date
          ? new Date(event.occurrence_date).toISOString()
          : null,
      });
    }
    setShowScopeModal(false);
    setPendingFormData(null);
    setScopeAction(null);
  };

  const handleDelete = async () => {
    if (!event) return;
    if (isRecurringOccurrence) {
      setScopeAction('delete');
      setShowScopeModal(true);
      return;
    }

    await onDelete(event.id);
  };

  const handleCancel = () => {
    form.resetFields();
    setShowScopeModal(false);
    setPendingFormData(null);
    setScopeAction(null);
    onClose();
  };

  if (!event) return null;

  const hasLinks = pages.length > 0 || slides.length > 0 || assignments.length > 0;
  const hasExistingLinks =
    (event._rawPageLinks?.length ?? 0) > 0 ||
    (event._rawSlideLinks?.length ?? 0) > 0 ||
    (event._rawAssignmentLinks?.length ?? 0) > 0 ||
    Boolean(event.meeting_link);

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
      <Form form={form} layout="vertical" requiredMark={false}>
        {/* Gmail-style header */}
        <div className="flex items-center justify-between gap-3 px-5 py-3 bg-stone-50 dark:bg-neutral-800/60 border-b border-stone-200 dark:border-neutral-800">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Edit event</span>
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
          {hasExistingLinks && (
            <div className="mb-3">
              <EventLinks
                event={event}
                classSlug={classSlug}
                rolePrefix={rolePrefix}
                slidesUrl={slidesUrl ?? ''}
                pagesUrl={pagesUrl}
              />
            </div>
          )}

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
                {isRecurringOccurrence && (
                  <div className="flex items-start gap-2 rounded-lg bg-[#FEF3EC] dark:bg-amber-900/20 border border-[#F4D8C5] dark:border-amber-800/40 px-3 py-2 text-xs text-[#8a5b3a] dark:text-amber-200 mb-2">
                    <IconInfoCircle size={14} className="shrink-0 mt-0.5" />
                    <div>
                      Resource links are specific to this occurrence. They won&apos;t affect other
                      dates in the series.
                    </div>
                  </div>
                )}
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
              </InlineRow>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-stone-200 dark:border-neutral-800 bg-stone-50/60 dark:bg-neutral-800/40">
          <Button
            type="text"
            danger
            icon={<IconTrash size={14} />}
            loading={loading}
            onClick={handleDelete}
          >
            Delete
          </Button>
          <Space>
            <Button onClick={handleCancel} type="text">
              Cancel
            </Button>
            <Button
              type="primary"
              loading={loading}
              onClick={handleSubmit}
              style={{ backgroundColor: '#619462', borderColor: '#619462' }}
            >
              Save changes
            </Button>
          </Space>
        </div>
      </Form>

      {/* Scope selection modal for recurring events */}
      <Modal
        title={scopeAction === 'delete' ? 'Delete Recurring Event' : 'Edit Recurring Event'}
        open={showScopeModal}
        onCancel={() => {
          setShowScopeModal(false);
          setPendingFormData(null);
          setScopeAction(null);
        }}
        onOk={handleScopeConfirm}
        okText={scopeAction === 'delete' ? 'Delete' : 'Save'}
        okButtonProps={{ danger: scopeAction === 'delete', loading }}
        cancelText="Cancel"
      >
        <div className="py-4">
          <p className="text-gray-600 mb-4">
            This is a recurring event. Which occurrences do you want to{' '}
            {scopeAction === 'delete' ? 'delete' : 'update'}?
          </p>
          <Radio.Group
            value={editScope}
            onChange={e => setEditScope(e.target.value)}
            className="flex flex-col gap-2"
          >
            <Radio value={EDIT_SCOPES.THIS_ONLY}>Only this event</Radio>
            <Radio value={EDIT_SCOPES.THIS_AND_FUTURE}>This and future events</Radio>
            <Radio value={EDIT_SCOPES.ALL}>All events in series</Radio>
          </Radio.Group>
        </div>
      </Modal>
    </Modal>
  );
};

export default EditEventModal;
export type { EventFormData };
