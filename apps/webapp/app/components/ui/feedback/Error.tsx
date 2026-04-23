import React from 'react';

const Error = (props: React.JSX.IntrinsicElements['div']) => {
  return <div className="text-sm text-red-600" {...props} style={{ color: 'red' }} />;
};

export default Error;
