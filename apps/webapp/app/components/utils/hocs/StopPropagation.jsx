import React from 'react';

const StopPropagation = ({ children }) => {
  // Function to stop event propagation
  const stopProp = event => {
    event.stopPropagation();
  };

  // Clone the children and add the stopProp function to their props
  const childrenWithProps = React.Children.map(children, child =>
    React.cloneElement(child, { onClick: stopProp })
  );

  return <>{childrenWithProps}</>;
};

export default StopPropagation;
