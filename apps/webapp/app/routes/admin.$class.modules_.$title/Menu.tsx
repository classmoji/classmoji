import { Button, Dropdown, Modal } from 'antd';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'react-toastify';
import { useGlobalFetcher, useSubscription } from '~/hooks';
import LocalStorage from '~/utils/localStorage';

interface MenuProps {
  module: {
    id: string;
    type: string;
    title?: string;
    is_published?: boolean;
    assignments?: unknown[];
    [key: string]: unknown;
  };
  assistants: Array<{ id: string }>;
  repos?: unknown;
  fetcher?: unknown;
  notify?: unknown;
}

const Menu = ({ module, assistants }: MenuProps) => {
  const navigate = useNavigate();
  const { class: classSlug, title: moduleTitle } = useParams();
  const { fetcher } = useGlobalFetcher();
  const { isProTier } = useSubscription();

  const submitModulePublish = (intent: 'publish' | 'unpublish') => {
    fetcher!.submit(
      { assignment_id: module.id },
      {
        method: 'post',
        action: `/admin/${classSlug}/modules?/${intent}`,
        encType: 'application/json',
      }
    );
    LocalStorage.forceRefreshRepos();
  };

  const confirmModulePublishToggle = () => {
    if (module.is_published) {
      Modal.confirm({
        title: `Unpublish module "${module.title ?? ''}"?`,
        content:
          'Students will no longer see this module or its assignments. Existing repositories are kept and you can republish at any time.',
        okText: 'Unpublish',
        okButtonProps: { danger: true },
        cancelText: 'Cancel',
        onOk: () => submitModulePublish('unpublish'),
      });
    } else {
      Modal.confirm({
        title: `Publish module "${module.title ?? ''}"?`,
        content:
          'This will make the module available to students and create repositories if needed.',
        okText: 'Publish',
        cancelText: 'Cancel',
        onOk: () => submitModulePublish('publish'),
      });
    }
  };

  const calculateContributions = () => {
    if (module.type === 'INDIVIDUAL') {
      toast.error('Individual assignments do not support calculating contributions');
      return;
    }

    fetcher!.submit(JSON.stringify({ module }), {
      method: 'post',
      action: `/admin/${classSlug}/modules/${moduleTitle}?action=calculateContributions`,
      encType: 'application/json',
    });
  };

  const items = [
    {
      key: 'edit',
      label: (
        <button
          onClick={() => {
            navigate(`/admin/${classSlug}/modules/form?title=${moduleTitle}`);
          }}
        >
          Edit module
        </button>
      ),
    },
    {
      key: 'toggle-publish',
      danger: module.is_published,
      label: (
        <button onClick={confirmModulePublishToggle}>
          {module.is_published ? 'Unpublish module' : 'Publish module'}
        </button>
      ),
    },
    isProTier && {
      key: 'assign-graders',
      label: (
        <button
          onClick={() => {
            if (!module.assignments || module.assignments.length === 0) {
              toast.error('No assignments to assign graders');
              return;
            }

            if (assistants.length === 0) {
              toast.error('No graders found');
              return;
            }

            navigate(`/admin/${classSlug}/modules/${moduleTitle}/assign-graders`);
          }}
        >
          Assign graders
        </button>
      ),
    },
    {
      key: 'update-repositories',
      label: (
        <button
          onClick={() => {
            navigate(`/admin/${classSlug}/modules/${moduleTitle}/update?id=${module.id}`);
          }}
        >
          Update repositories
        </button>
      ),
    },
    module.type === 'GROUP' && {
      key: 'calculate-contributions',
      label: <button onClick={calculateContributions}>Calculate contributions</button>,
    },
  ];

  return (
    <Dropdown
      menu={{ items: items.filter(Boolean) as Array<{ key: string; label: React.ReactNode }> }}
      placement="bottomLeft"
    >
      <Button>Actions</Button>
    </Dropdown>
  );
};

export default Menu;
