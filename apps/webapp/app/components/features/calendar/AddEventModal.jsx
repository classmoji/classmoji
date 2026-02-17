import { useState } from 'react';
import { Drawer, Form, Input, Select, DatePicker, TimePicker, Checkbox, Space, Button, Alert } from 'antd';
import { LinkOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { getEventTypeLabel } from './utils';

const { TextArea } = Input;
const { Option } = Select;

const ALL_EVENT_TYPES = [
  'OFFICE_HOURS',
  'LECTURE',
  'LAB',
  'ASSESSMENT',
];

const DAYS_OF_WEEK = [
  { value: 'monday', label: 'Monday' },
  { value: 'tuesday', label: 'Tuesday' },
  { value: 'wednesday', label: 'Wednesday' },
  { value: 'thursday', label: 'Thursday' },
  { value: 'friday', label: 'Friday' },
  { value: 'saturday', label: 'Saturday' },
  { value: 'sunday', label: 'Sunday' },
];

const AddEventModal = ({
  open,
  onClose,
  onSubmit,
  loading = false,
  allowedEventTypes = ALL_EVENT_TYPES,
  pages = [],
  slides = [],
  assignments = [],
}) => {
  const eventTypes = allowedEventTypes.length > 0 ? allowedEventTypes : ALL_EVENT_TYPES;
  const [form] = Form.useForm();
  const [isRecurring, setIsRecurring] = useState(false);

  // State for linked resources
  const [linkedPageIds, setLinkedPageIds] = useState([]);
  const [linkedSlideIds, setLinkedSlideIds] = useState([]);
  const [linkedAssignmentIds, setLinkedAssignmentIds] = useState([]);

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
        recurrence_rule: isRecurring ? {
          days: values.recurrence_days || [],
          until: values.recurrence_until ? values.recurrence_until.toDate().toISOString() : null,
        } : null,
        // Include linked resources only for non-recurring events
        // For recurring events, links should be added per-occurrence after creation
        ...(isRecurring ? {} : {
          linkedPageIds,
          linkedSlideIds,
          linkedAssignmentIds,
        }),
      };

      await onSubmit(eventData);
      form.resetFields();
      setIsRecurring(false);
      setLinkedPageIds([]);
      setLinkedSlideIds([]);
      setLinkedAssignmentIds([]);
    } catch (error) {
      console.error('Form validation failed:', error);
    }
  };

  const handleCancel = () => {
    form.resetFields();
    setIsRecurring(false);
    setLinkedPageIds([]);
    setLinkedSlideIds([]);
    setLinkedAssignmentIds([]);
    onClose();
  };

  return (
    <Drawer
      title="Add Calendar Event"
      open={open}
      onClose={handleCancel}
      width={600}
      footer={
        <div className="flex items-center justify-end">
          <Space>
            <Button onClick={handleCancel} type="default">
              Cancel
            </Button>
            <Button type="primary" loading={loading} onClick={handleSubmit}>
              Create Event
            </Button>
          </Space>
        </div>
      }
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          event_type: 'OFFICE_HOURS',
          date: dayjs(),
          start_time: dayjs(),
          end_time: dayjs().add(1, 'hour'),
        }}
      >
        <Form.Item
          name="event_type"
          label="Event Type"
          rules={[{ required: true, message: 'Please select an event type' }]}
        >
          <Select disabled={eventTypes.length === 1}>
            {eventTypes.map(type => (
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
          <Checkbox checked={isRecurring} onChange={(e) => setIsRecurring(e.target.checked)}>
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

            {isRecurring ? (
              <Alert
                type="info"
                message="For recurring events, add resource links to specific dates by editing individual occurrences after creation."
                className="mb-3"
                showIcon
              />
            ) : (
              <>
                {pages.length > 0 && (
                  <Form.Item label="Pages">
                    <Select
                      mode="multiple"
                      placeholder="Select pages to link"
                      value={linkedPageIds}
                      onChange={setLinkedPageIds}
                      options={pages.map(p => ({ value: p.id, label: p.title }))}
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
                      options={slides.map(s => ({ value: s.id, label: s.title }))}
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
                      options={assignments.map(a => ({
                        value: a.id,
                        label: `${a.module?.title}: ${a.title}`,
                      }))}
                      optionFilterProp="label"
                      allowClear
                    />
                  </Form.Item>
                )}
              </>
            )}
          </div>
        )}
      </Form>
    </Drawer>
  );
};

export default AddEventModal;
