import { Form, Input } from 'antd';

export default function CreateBlankTab() {
  return (
    <div className="space-y-4">
      <Form.Item
        label="Title"
        name="title"
        rules={[{ required: true, message: 'Please enter a title' }]}
      >
        {/* Starting focus: antd 6's modal would otherwise focus its Close button. */}
        <Input placeholder="Course Overview" data-tour="pages-new-title" autoFocus />
      </Form.Item>

      {/* Hidden inputs */}
      <input type="hidden" name="intent" value="create-blank" />
    </div>
  );
}
