import React from 'react';

interface StopPropagationProps {
  children: React.ReactNode;
}

const StopPropagation = ({ children }: StopPropagationProps) => {
  // Function to stop event propagation
  const stopProp = (event: React.MouseEvent) => {
    event.stopPropagation();
  };

  // Clone the children and add the stopProp function to their props
  const childrenWithProps = React.Children.map(children, child =>
    React.isValidElement(child) ? React.cloneElement(child, { onClick: stopProp } as React.HTMLAttributes<HTMLElement>) : child
  );

  return <>{childrenWithProps}</>;
};

export default StopPropagation;
