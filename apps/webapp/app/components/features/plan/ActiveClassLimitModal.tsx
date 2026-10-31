import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Modal } from 'antd';

interface ActiveClassroom {
  id: string;
  name: string;
  slug: string;
}

/** What a create action answers when the Free plan's one-active-class rule refuses it. */
export interface ActiveClassLimitData {
  error?: string;
  activeClassLimit?: { activeClassrooms: ActiveClassroom[] };
}

/**
 * The choice offered when a new class would go past the Free plan's one active
 * class: archive one of yours and continue, or upgrade. Opens whenever the
 * create action answers with `activeClassLimit`.
 */
const ActiveClassLimitModal = ({
  data,
  onArchiveAndContinue,
}: {
  data: ActiveClassLimitData | undefined;
  onArchiveAndContinue: (classroomId: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const classrooms = data?.activeClassLimit?.activeClassrooms ?? [];

  useEffect(() => {
    if (data?.activeClassLimit) setOpen(true);
  }, [data]);

  return (
    <Modal
      open={open}
      onCancel={() => setOpen(false)}
      footer={null}
      title="One active class on the Free plan"
    >
      <p className="text-sm text-ink-2 mb-4">
        Archiving a class makes it read-only for students and staff and takes its public class site
        offline. Owners can still edit it, and you can make it active again later.
      </p>
      <div className="flex flex-col gap-2">
        {classrooms.map(classroom => (
          <button
            key={classroom.id}
            type="button"
            className="btn justify-between"
            onClick={() => {
              setOpen(false);
              onArchiveAndContinue(classroom.id);
            }}
          >
            <span>Archive {classroom.name} and continue</span>
          </button>
        ))}
        <Link to="/settings/billing" className="btn btn-primary">
          Upgrade to Pro
        </Link>
      </div>
    </Modal>
  );
};

export default ActiveClassLimitModal;
