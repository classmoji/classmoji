import { Button } from 'antd';
import { IconPlus } from '@tabler/icons-react';

interface ButtonNewProps {
  action?: () => void;
  children: React.ReactNode;
}

const ButtonNew = ({ action, children }: ButtonNewProps) => {
  return (
    <Button type="primary" onClick={action ? action : () => {}} icon={<IconPlus size={16} />}>
      {children}
    </Button>
  );
};

export default ButtonNew;
