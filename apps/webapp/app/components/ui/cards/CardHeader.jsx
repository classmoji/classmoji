import React from 'react';

const CardHeader = ({ children }) => {
  return (
    <div className="flex items-center pb-7">
      <div className="w-1 h-6 bg-primary mr-3 rounded-full"></div>
      <h1 className="text-[16px] font-header text-black dark:text-gray-200 font-bold">
        {children}
      </h1>
    </div>
  );
};

export default CardHeader;
