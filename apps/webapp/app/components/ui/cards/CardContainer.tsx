import React from 'react';

interface CardContainerProps {
  children: React.ReactNode;
  className?: string;
}

const CardContainer = ({ children, className }: CardContainerProps) => {
  return (
    <div
      className={`shadow-xs border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 rounded-lg ${className}`}
    >
      {children}
    </div>
  );
};

export default CardContainer;
