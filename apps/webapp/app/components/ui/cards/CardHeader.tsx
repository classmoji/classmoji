import React from 'react';

interface CardHeaderProps {
  children: React.ReactNode;
}

const CardHeader = ({ children }: CardHeaderProps) => {
  return (
    <div className="flex items-center pb-7">
      <h1 className="text-sm font-semibold text-ink-0">
        {children}
      </h1>
    </div>
  );
};

export default CardHeader;
