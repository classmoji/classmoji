import { Drawer } from 'antd';
import { useNavigate } from 'react-router';
import ResourcesKanban from './ResourcesKanban';

export { loader } from './loader';
export { action } from './action';

export default function ResourcesPage({ loaderData }) {
  const { modules, pages, slides } = loaderData;
  const navigate = useNavigate();

  const handleClose = () => {
    navigate(-1);
  };

  return (
    <Drawer
      title="Link Resources"
      open={true}
      onClose={handleClose}
      width="100%"
      destroyOnClose
      styles={{
        body: { padding: 0, display: 'flex', flexDirection: 'column', height: '100%' },
      }}
    >
      <ResourcesKanban modules={modules} pages={pages} slides={slides} />
    </Drawer>
  );
}
