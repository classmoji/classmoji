import { Modal, Radio, Button, message } from 'antd';
import { SettingSection } from '~/components';

type Status = 'ACTIVE' | 'LOCKED' | 'UNPUBLISHED';

interface StatusSectionProps {
  classroomId: string;
  status: Status;
  isArchived: boolean;
}

const STATUS_OPTIONS: { value: Status; label: string; desc: string }[] = [
  {
    value: 'ACTIVE',
    label: 'Active',
    desc: 'Normal access. Members can read and write according to their role.',
  },
  {
    value: 'LOCKED',
    label: 'Locked (read-only)',
    desc: 'Members can view everything but cannot make changes.',
  },
  {
    value: 'UNPUBLISHED',
    label: 'Unpublished',
    desc: 'Members see the card but cannot enter the class.',
  },
];

const StatusSection = ({ classroomId, status, isArchived }: StatusSectionProps) => {
  const setStatus = async (next: Status) => {
    const response = await fetch(`/api/classrooms/${classroomId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: next }),
    });
    if (!response.ok) {
      // Making a class Active again can be refused by the Free plan's
      // one-active-class rule; the server says why.
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      message.error(body?.error ?? 'Could not change the class status.');
      return;
    }
    window.location.reload();
  };

  const setArchived = (next: boolean) => {
    Modal.confirm({
      title: next ? 'Archive class?' : 'Unarchive class?',
      content: next
        ? 'The class will be moved to the Archived section on the landing page and its public class site goes offline. Access is not changed, and it still counts as your active class on the Free plan: set the status to Locked to free that.'
        : 'The class will be returned to the active list.',
      okText: next ? 'Archive' : 'Unarchive',
      onOk: async () => {
        await fetch(`/api/classrooms/${classroomId}/archive`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_archived: next }),
        });
        window.location.reload();
      },
    });
  };

  return (
    <>
      <SettingSection
        title="Class status"
        description="Applies to teaching assistants and students only — owners always retain full access."
      >
        <div className="space-y-3" data-tour="settings-status">
          {STATUS_OPTIONS.map(opt => (
            <label key={opt.value} className="flex items-start gap-3 cursor-pointer">
              <Radio checked={status === opt.value} onChange={() => setStatus(opt.value)} />
              <span>
                <span className="font-medium">{opt.label}</span>
                <span className="block text-sm text-ink-3">{opt.desc}</span>
              </span>
            </label>
          ))}
        </div>
      </SettingSection>

      <SettingSection
        title="Archive"
        description="Move this class out of the way on your landing page and take its public class site offline. Archiving does not change access, and it does not free your Free plan's active class: only the Locked or Unpublished status does."
      >
        <Button onClick={() => setArchived(!isArchived)} data-tour="settings-archive">
          {isArchived ? 'Unarchive class' : 'Archive class'}
        </Button>
      </SettingSection>
    </>
  );
};

export default StatusSection;
