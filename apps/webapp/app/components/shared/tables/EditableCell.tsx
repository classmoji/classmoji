import { useState, useEffect } from 'react';
import { useClickAway } from '@uidotdev/usehooks';

import { InputNumber, Input } from 'antd';

interface EditableRecord {
  id: string | number;
  [key: string]: unknown;
}

type ValueType = string | number | null | undefined;

interface EditableCellProps {
  record: EditableRecord;
  dataIndex: string;
  onUpdate: (recordId: string | number, value: ValueType) => void;
  /** 'number' shows the value as a percentage (`N%`) and edits it as a plain number. */
  format?: 'text' | 'number';
  placeholder?: string;
  /** The smallest number the editor takes (format 'number'). */
  min?: number;
}

const EditableCell = ({
  record,
  dataIndex,
  onUpdate,
  format = 'text',
  placeholder,
  min,
}: EditableCellProps) => {
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState<ValueType>(record?.[dataIndex] as ValueType);

  // Sync inputValue when record changes (e.g., after revalidation)
  useEffect(() => {
    setInputValue(record?.[dataIndex] as ValueType);
  }, [record?.[dataIndex]]);

  const ref = useClickAway(() => {
    setEditing(false);
  }) as React.RefObject<HTMLDivElement>;

  if (!record) return null;

  const handleKeyPress = (event: React.KeyboardEvent<HTMLElement>) => {
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
        {format === 'number' ? `${inputValue ?? 0}%` : inputValue} {!inputValue && placeholder}
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
          min={min}
          onKeyDown={handleKeyPress}
          onChange={value => setInputValue(value)}
          value={inputValue as number | null}
        />
      ) : (
        <Input
          className="w-full"
          onKeyDown={handleKeyPress}
          onChange={e => setInputValue(e.target.value)}
          value={inputValue as string | undefined}
          variant="borderless"
        />
      )}
    </div>
  );
};

export default EditableCell;
