import { Button, Dropdown } from 'antd';
import { useNavigate, useParams } from 'react-router';
import { useCallout } from '@classmoji/ui-components';
import { useGlobalFetcher, useSubscription } from '~/hooks';

interface MenuProps {
  module: {
    id: string;
    type: string;
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
  const callout = useCallout();

  const calculateContributions = () => {
    if (module.type === 'INDIVIDUAL') {
      callout.show({
        variant: 'error',
        title: 'Individual assignments do not support calculating contributions',
      });
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
    isProTier && {
      key: 'assign-graders',
      label: (
        <button
          onClick={() => {
            if (!module.assignments || module.assignments.length === 0) {
              callout.show({ variant: 'error', title: 'No assignments to assign graders' });
              return;
            }

            if (assistants.length === 0) {
              callout.show({ variant: 'error', title: 'No graders found' });
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
