import { useState } from 'react';
import { Button, Input, Modal } from 'antd';
import { useCallout } from '@classmoji/ui-components';
import { CopyOutlined, CheckOutlined, CalendarOutlined } from '@ant-design/icons';

interface CalendarSubscriptionCardProps {
  subscriptionUrl?: string | null;
}

const CalendarSubscriptionCard = ({ subscriptionUrl }: CalendarSubscriptionCardProps) => {
  const callout = useCallout();
  const [modalOpen, setModalOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Don't render if no subscription URL (CALENDAR_SECRET not configured)
  if (!subscriptionUrl) {
    return null;
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(subscriptionUrl);
      setCopied(true);
      callout.show({ variant: 'success', title: 'Calendar URL copied' });
      setTimeout(() => setCopied(false), 2000);
    } catch (_err: unknown) {
      callout.show({ variant: 'error', title: 'Could not copy the URL' });
    }
  };

  return (
    <>
      <Button icon={<CalendarOutlined />} onClick={() => setModalOpen(true)}>
        Subscribe
      </Button>

      <Modal
        title="Subscribe to Calendar"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        footer={null}
        width={500}
      >
        <p className="text-ink-2 mb-4">
          Add this URL to Google Calendar, Apple Calendar, or Outlook to automatically sync events.
        </p>
        <div className="flex gap-2">
          <Input value={subscriptionUrl} readOnly className="font-mono text-xs" />
          <Button
            icon={copied ? <CheckOutlined /> : <CopyOutlined />}
            onClick={handleCopy}
            type={copied ? 'primary' : 'default'}
          >
            {copied ? 'Copied!' : 'Copy'}
          </Button>
        </div>
        <div className="mt-4 text-xs text-gray-500 dark:text-gray-500">
          <strong>How to add:</strong>
          <ul className="mt-1 ml-4 list-disc">
            <li>Google Calendar: Settings → Add calendar → From URL</li>
            <li>Apple Calendar: File → New Calendar Subscription</li>
            <li>Outlook: Add calendar → Subscribe from web</li>
          </ul>
        </div>
      </Modal>
    </>
  );
};

export default CalendarSubscriptionCard;
