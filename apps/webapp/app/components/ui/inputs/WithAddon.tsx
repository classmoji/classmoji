import { cloneElement, type ReactElement, type ReactNode } from 'react';
import { Form, Space } from 'antd';

interface WithAddonProps {
  /** The cell before the input (antd 5's `addonBefore`). */
  before?: ReactNode;
  /** The cell after the input (antd 5's `addonAfter`). */
  after?: ReactNode;
  /** The input: an antd Input or InputNumber. */
  children: ReactElement<Record<string, unknown>>;
  /** Fill the row, as antd 5's addon group did. */
  block?: boolean;
  className?: string;
  /** Greys the addons too (antd 6's Space.Addon does not read a Form's `disabled`). */
  disabled?: boolean;
}

/**
 * An input with addon cells the antd 6 way (Space.Compact + Space.Addon),
 * usable as a Form.Item's direct child: what the Form.Item injects (value,
 * onChange, id, aria-describedby, …) goes on to the input, so the label, the
 * required mark and the error text stay tied to it, and the addons take the
 * item's validation status, which Space.Addon does not read on its own.
 */
const WithAddon = ({
  before,
  after,
  children,
  block,
  className,
  disabled,
  ...injected
}: WithAddonProps & Record<string, unknown>) => {
  const { status } = Form.Item.useStatus();
  const addonStatus = status === 'error' || status === 'warning' ? status : undefined;
  return (
    <Space.Compact block={block} className={className}>
      {before !== undefined && (
        <Space.Addon status={addonStatus} disabled={disabled}>
          {before}
        </Space.Addon>
      )}
      {cloneElement(children, { ...injected, ...(disabled ? { disabled } : {}) })}
      {after !== undefined && (
        <Space.Addon status={addonStatus} disabled={disabled}>
          {after}
        </Space.Addon>
      )}
    </Space.Compact>
  );
};

export default WithAddon;
