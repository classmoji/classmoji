import { useState, useEffect } from 'react';
import {
  Drawer,
  Form,
  Input,
  Select,
  DatePicker,
  TimePicker,
  Checkbox,
  Space,
  Button,
  Modal,
  Radio,
  Alert,
} from 'antd';
import { DeleteOutlined, LinkOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { getEventTypeLabel, formatFullDate } from './utils';
import EventLinks from './EventLinks';

const { TextArea } = Input;
const { Option } = Select;

/**
 * Check if two dates represent the same calendar day
 * Uses UTC methods to avoid timezone issues when comparing dates from DB (UTC) with local dates
 */
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
  { value: 'monday', label: 'Monday' },
  { value: 'tuesday', label: 'Tuesday' },
  { value: 'wednesday', label: 'Wednesday' },
  { value: 'thursday', label: 'Thursday' },
  { value: 'friday', label: 'Friday' },
  { value: 'saturday', label: 'Saturday' },
  { value: 'sunday', label: 'Sunday' },
];

// Edit scope options for recurring events
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

interface EditEventModalProps {
  open: boolean;
  event: CalendarEvent | null;
  onClose: () => void;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
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
  const [editScope, setEditScope] = useState(EDIT_SCOPES.THIS_ONLY);
  const [showScopeModal, setShowScopeModal] = useState(false);
  const [scopeAction, setScopeAction] = useState<'edit' | 'delete' | null>(null);
  const [pendingFormData, setPendingFormData] = useState<Record<string, any> | null>(null);

  // State for linked resources
  const [linkedPageIds, setLinkedPageIds] = useState<string[]>([]);
  const [linkedSlideIds, setLinkedSlideIds] = useState<string[]>([]);
  const [linkedAssignmentIds, setLinkedAssignmentIds] = useState<string[]>([]);

  // Check if this is an occurrence of a recurring event (has occurrence_date)
  const isRecurringOccurrence = event?.is_recurring && event?.occurrence_date;

  useEffect(() => {
    if (event) {
      const startDate = dayjs(event.start_time);
      const endDate = dayjs(event.end_time);

      setIsRecurring(event.is_recurring || false);
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

      // Initialize linked resource IDs from event's raw links
      // For recurring events, filter links for this specific occurrence
      const occurrenceDate = event.occurrence_date || event.start_time;
      const filterLinksForOccurrence = <T extends { occurrence_date?: string | null }>(links: T[] | undefined) => {
        if (!links) return [];
        if (!links) return [];
        return links.filter(
          link =>
            !link.occurrence_date || isSameDateDay(link.occurrence_date, occurrenceDate)
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Ant Design form values are dynamically typed
  const buildEventData = (values: Record<string, any>, includeLinks = true) => {
    const startDate = values.date.toDate();
    const endDate = values.date.toDate();

    const startTime = values.start_time.toDate();
    const endTime = values.end_time.toDate();

    startDate.setHours(startTime.getHours(), startTime.getMinutes(), 0, 0);
    endDate.setHours(endTime.getHours(), endTime.getMinutes(), 0, 0);

    const eventData: Record<string, any> = {
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
            until: values.recurrence_until ? values.recurrence_until.toDate().toISOString() : null,
          }
        : null,
    };

    // Include linked resource IDs if requested
    // For recurring events with non-'this_only' scope, we skip links (they're instance-specific)
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

      // For recurring occurrences, show scope selection modal
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
      // Only include links for 'this_only' scope (links are instance-specific)
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
    // For recurring occurrences, show scope selection modal
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

  const occurrenceDateFormatted = event.occurrence_date
    ? formatFullDate(new Date(event.occurrence_date))
    : '';

  return (
    <Drawer
      title="Edit Calendar Event"
      open={open}
      onClose={handleCancel}
      width={600}
      footer={
        <div className="flex items-center justify-between">
          <Button
            type="primary"
            danger
            icon={<DeleteOutlined />}
            loading={loading}
            onClick={handleDelete}
          >
            Delete Event
          </Button>
          <Space>
            <Button onClick={handleCancel} type="default">
              Cancel
            </Button>
            <Button type="primary" loading={loading} onClick={handleSubmit}>
              Save Changes
            </Button>
          </Space>
        </div>
      }
    >
      {/* Show clickable links at the top */}
      <div className="mb-4">
        <EventLinks
          event={event}
          classSlug={classSlug}
          rolePrefix={rolePrefix}
          slidesUrl={slidesUrl}
          pagesUrl={pagesUrl}
        />
      </div>

      <Form form={form} layout="vertical">
        <Form.Item
          name="event_type"
          label="Event Type"
          rules={[{ required: true, message: 'Please select an event type' }]}
        >
          <Select disabled={eventTypes.length === 1}>
            {eventTypes.map((type: string) => (
              <Option key={type} value={type}>
                {getEventTypeLabel(type)}
              </Option>
            ))}
          </Select>
        </Form.Item>

        <Form.Item
          name="title"
          label="Title"
          rules={[{ required: true, message: 'Please enter a title' }]}
        >
          <Input placeholder="e.g., Prof. Smith Office Hours" />
        </Form.Item>

        <Form.Item name="description" label="Description">
          <TextArea rows={3} placeholder="Optional description" />
        </Form.Item>

        <Space className="w-full" direction="vertical">
          <Form.Item
            name="date"
            label="Date"
            rules={[{ required: true, message: 'Please select a date' }]}
            className="mb-2"
          >
            <DatePicker className="w-full" />
          </Form.Item>

          <div className="grid grid-cols-2 gap-4">
            <Form.Item
              name="start_time"
              label="Start Time"
              rules={[{ required: true, message: 'Required' }]}
            >
              <TimePicker format="h:mm A" use12Hours className="w-full" />
            </Form.Item>

            <Form.Item
              name="end_time"
              label="End Time"
              rules={[{ required: true, message: 'Required' }]}
            >
              <TimePicker format="h:mm A" use12Hours className="w-full" />
            </Form.Item>
          </div>
        </Space>

        <Form.Item name="location" label="Location">
          <Input placeholder="e.g., Office 123, Building A" />
        </Form.Item>

        <Form.Item name="meeting_link" label="Meeting Link">
          <Input placeholder="e.g., https://zoom.us/j/..." />
        </Form.Item>

        <Form.Item>
          <Checkbox checked={isRecurring} onChange={e => setIsRecurring(e.target.checked)}>
            Recurring Event
          </Checkbox>
        </Form.Item>

        {isRecurring && (
          <>
            <Form.Item
              name="recurrence_days"
              label="Repeat On"
              rules={[{ required: true, message: 'Please select at least one day' }]}
            >
              <Checkbox.Group options={DAYS_OF_WEEK} />
            </Form.Item>

            <Form.Item
              name="recurrence_until"
              label="Repeat Until"
              rules={[{ required: true, message: 'Please select an end date' }]}
            >
              <DatePicker className="w-full" />
            </Form.Item>
          </>
        )}

        {/* Resource Links Section */}
        {(pages.length > 0 || slides.length > 0 || assignments.length > 0) && (
          <div className="border-t pt-4 mt-4">
            <div className="flex items-center gap-2 mb-3">
              <LinkOutlined className="text-gray-500" />
              <span className="font-medium">Linked Resources</span>
            </div>

            {isRecurringOccurrence && (
              <Alert
                type="info"
                message="Resource links are specific to this occurrence. They won't affect other dates in the series."
                className="mb-3"
                showIcon
              />
            )}

            {pages.length > 0 && (
              <Form.Item label="Pages">
                <Select
                  mode="multiple"
                  placeholder="Select pages to link"
                  value={linkedPageIds}
                  onChange={setLinkedPageIds}
                  options={pages.map((p: CalendarResource) => ({
                    value: p.id,
                    label: p.title,
                  }))}
                  optionFilterProp="label"
                  allowClear
                />
              </Form.Item>
            )}

            {slides.length > 0 && (
              <Form.Item label="Slides">
                <Select
                  mode="multiple"
                  placeholder="Select slide decks to link"
                  value={linkedSlideIds}
                  onChange={setLinkedSlideIds}
                  options={slides.map((s: CalendarResource) => ({
                    value: s.id,
                    label: s.title,
                  }))}
                  optionFilterProp="label"
                  allowClear
                />
              </Form.Item>
            )}

            {assignments.length > 0 && (
              <Form.Item label="Assignments">
                <Select
                  mode="multiple"
                  placeholder="Select assignments to link"
                  value={linkedAssignmentIds}
                  onChange={setLinkedAssignmentIds}
                  options={assignments.map((a: CalendarAssignment) => ({
                    value: a.id,
                    label: `${a.module?.title}: ${a.title}`,
                  }))}
                  optionFilterProp="label"
                  allowClear
                />
              </Form.Item>
            )}
          </div>
        )}
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
    </Drawer>
  );
};

export default EditEventModal;
