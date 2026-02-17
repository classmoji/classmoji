import { Tag, Checkbox } from 'antd';
import { IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { useClickAway } from '@uidotdev/usehooks';

const ButtonFilter = ({ label }) => {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useClickAway(() => {
    setIsOpen(false);
  });

  const options = [
    { label: 'Apple', value: 'Apple' },
    { label: 'Pear', value: 'Pear' },
    { label: 'Orange', value: 'Orange' },
  ];

  const optionList = options.map(option => {
    return (
      <div key={option.value}>
        <Checkbox className="truncate h-[20px] text-sm" key={option.value}>
          {option.label}
        </Checkbox>
      </div>
    );
  });

  return (
    <div className="relative" ref={ref}>
      <button
        className="border border-gray-300 dark:border-gray-600 px-3 py-2 rounded-md shadow-xs bg-white dark:bg-gray-800"
        onClick={() => setIsOpen(true)}
      >
        <div className="flex gap-2 items-center">
          <span className="text-gray-500">{label}</span>
          <Tag color="green" className="mr-0">
            5
          </Tag>
          <span className="font-bold text-gray-900 dark:text-gray-100">selected</span>
          <IconX
            size={16}
            className="cursor-pointer text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          />
        </div>
      </button>
      {isOpen && (
        <div className="min-w-[250px] border border-gray-300 dark:border-gray-600 absolute z-10 mt-3 shadow-lg bg-white dark:bg-gray-800 px-4 py-4 flex flex-col gap-2 rounded-lg">
          {optionList}
        </div>
      )}
    </div>
  );
};

export default ButtonFilter;
