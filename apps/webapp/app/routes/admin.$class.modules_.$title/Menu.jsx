import { Button, Dropdown } from 'antd';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'react-toastify';
import { useGlobalFetcher, useSubscription } from '~/hooks';

const Menu = ({ module, assistants }) => {
  const navigate = useNavigate();
  const { class: classSlug, title: moduleTitle } = useParams();
  const { fetcher } = useGlobalFetcher();
  const { isProTier } = useSubscription();

  const calculateContributions = () => {
    if (module.type === 'INDIVIDUAL') {
      toast.error('Individual assignments do not support calculating contributions');
      return;
    }

    fetcher.submit(
      { module },
      {
        method: 'post',
        action: `/admin/${classSlug}/modules/${moduleTitle}?action=calculateContributions`,
        encType: 'application/json',
      }
    );
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
    <Dropdown menu={{ items }} placement="bottomLeft">
      <Button>Actions</Button>
    </Dropdown>
  );
};

export default Menu;
