import { Button } from 'antd';
import { IconPlus } from '@tabler/icons-react';

const ButtonNew = ({ action, children }) => {
  return (
    <Button type="primary" onClick={action ? action : () => {}} icon={<IconPlus size={16} />}>
      {children}
    </Button>
  );
};

export default ButtonNew;
