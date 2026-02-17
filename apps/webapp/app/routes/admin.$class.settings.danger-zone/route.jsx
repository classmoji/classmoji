import { Button, Modal } from 'antd';

import { namedAction } from 'remix-utils/named-action';
import { useNavigate, useParams } from 'react-router';

import { useGlobalFetcher, useDisclosure } from '~/hooks';
import { ClassmojiService } from '@classmoji/services';
import { ActionTypes } from '~/constants';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';

const DangerZone = () => {
  const { fetcher, notify } = useGlobalFetcher();
  const { show, close, visible } = useDisclosure();
  const { class: classSlug } = useParams();
  const navigate = useNavigate();

  const onRemoveClassroom = () => {
    notify(ActionTypes.REMOVE_CLASSROOM, 'Removing classroom...');
    fetcher.submit(
      {},
      {
        method: 'delete',
        action: `?/removeClassroom`,
      }
    );

    navigate('/select-organization');
  };

  return (
    <>
      <Modal
        title={`Remove ${classSlug} classroom`}
        open={visible}
        onOk={onRemoveClassroom}
        onCancel={() => close()}
        okText="Remove"
        okButtonProps={{ danger: true }}
      >
        <p>
          The following data will be removed: modules, student enrollments, grades, quizzes, and
          classroom settings.
        </p>
        <p className="pt-3">Are you sure you want to proceed?</p>
      </Modal>
      <div>
        <p>Woah! I hope you know what you are doing.</p>
        <p className="pt-6 font-bold text-lg">Remove Classroom </p>
        <p className="w-1/2 pb-4 pt-1">
          This action will remove the classroom and all its associated data. There is no going back.
        </p>
        <Button type="primary" danger onClick={show}>
          Remove
        </Button>
      </div>
    </>
  );
};

export const action = async ({ request, params }) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'SETTINGS',
    action: 'delete_classroom',
  });

  return namedAction(request, {
    async removeClassroom() {
      return removeClassroomHandler(classroom);
    },
  });
};

const removeClassroomHandler = async classroom => {
  // Only delete the classroom data - don't remove the GitHub installation
  // since multiple classrooms can share the same git organization
  await ClassmojiService.classroom.deleteById(classroom.id);
  return {
    action: ActionTypes.REMOVE_CLASSROOM,
    success: 'Classroom removed successfully!',
  };
};

export default DangerZone;
