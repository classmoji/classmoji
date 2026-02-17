import { Tooltip } from 'antd';
import { IconInfoCircle } from '@tabler/icons-react';

const InfoTooltip = ({ children, tooltip }) => {
  return (
    <div className="flex items-center gap-2">
      {children}
      <Tooltip title={tooltip}>
        <IconInfoCircle size="16px" />
      </Tooltip>
    </div>
  );
};

export default InfoTooltip;
