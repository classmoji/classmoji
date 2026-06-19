import React from 'react';

const Error = (props: React.JSX.IntrinsicElements['div']) => {
  return <div className="text-sm text-red-600 dark:text-red-400" {...props} />;
};

export default Error;
