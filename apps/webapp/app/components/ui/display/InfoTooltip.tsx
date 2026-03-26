import { Tooltip } from 'antd';
import { IconInfoCircle } from '@tabler/icons-react';

interface InfoTooltipProps {
  children: React.ReactNode;
  tooltip: React.ReactNode;
}

const InfoTooltip = ({ children, tooltip }: InfoTooltipProps) => {
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
