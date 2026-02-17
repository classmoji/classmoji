import { useState, useEffect } from 'react';
import { useClickAway } from '@uidotdev/usehooks';

import { InputNumber, Input } from 'antd';

const EditableCell = ({ record, dataIndex, onUpdate, format = 'text', placeholder }) => {
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState(record?.[dataIndex]);

  // Sync inputValue when record changes (e.g., after revalidation)
  useEffect(() => {
    setInputValue(record?.[dataIndex]);
  }, [record?.[dataIndex]]);

  const ref = useClickAway(() => {
    setEditing(false);
  });

  if (!record) return null;

  const handleKeyPress = event => {
    if (event.key === 'Enter') {
      setEditing(false);
      onUpdate(record.id, inputValue);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        className="w-full cursor-pointer text-left bg-transparent border-none p-0 m-0"
        onClick={() => {
          setEditing(true);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setEditing(true);
          }
        }}
      >
        {inputValue} {format === 'number' && '%'} {!inputValue && placeholder}
      </button>
    );
  }

  return (
    <div
      ref={ref}
      onMouseLeave={() => {
        setEditing(false);
        onUpdate(record.id, inputValue);
      }}
    >
      {format === 'number' ? (
        <InputNumber
          className="w-full"
          formatter={value => `${value} %`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
          onKeyDown={handleKeyPress}
          onChange={value => setInputValue(value)}
          value={inputValue}
        />
      ) : (
        <Input
          className="w-full"
          onKeyDown={handleKeyPress}
          onChange={e => setInputValue(e.target.value)}
          value={inputValue}
          variant="borderless"
        />
      )}
    </div>
  );
};

export default EditableCell;
