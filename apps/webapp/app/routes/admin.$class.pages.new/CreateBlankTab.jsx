import { Form, Input } from 'antd';

export default function CreateBlankTab() {
  return (
    <div className="space-y-4">
      <Form.Item
        label="Title"
        name="title"
        rules={[{ required: true, message: 'Please enter a title' }]}
      >
        <Input placeholder="Course Overview" />
      </Form.Item>

      {/* Hidden inputs */}
      <input type="hidden" name="intent" value="create-blank" />
    </div>
  );
}
