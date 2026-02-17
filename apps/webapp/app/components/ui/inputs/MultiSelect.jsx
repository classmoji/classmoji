import { useState, useEffect } from 'react';
import { Checkbox, Popover } from 'antd';

const MultiSelect = ({ options, defaultValue = [], onSelect, onDeselect }) => {
  const [selected, setSelected] = useState(defaultValue || []);

  // Sync state when defaultValue changes (e.g., after revalidation)
  useEffect(() => {
    setSelected(defaultValue || []);
  }, [JSON.stringify(defaultValue)]);

  const Choices = () => {
    return (
      <div className="p-3 pb-5 bg-white ">
        <h2 className="font-semibold pb-3">Graders</h2>
        <div className="flex flex-col gap-3 min-h-[30px] overflow-y-scroll z-10">
          {options.length ? (
            options.map(option => (
              <div key={option.value}>
                <Checkbox
                  className="truncate h-[20px] text-sm"
                  checked={selected.includes(option.value)}
                  onChange={e => {
                    if (e.target.checked) {
                      setSelected([...selected, option.value]);
                      onSelect(option.value);
                    } else {
                      setSelected(selected.filter(s => s !== option.value));
                      onDeselect(option.value);
                    }
                  }}
                >
                  {option.label}
                </Checkbox>
              </div>
            ))
          ) : (
            <div>None</div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="w-[150px]">
      <Popover content={<Choices />} trigger="hover" placement="right">
        <div className="cursor-pointer px-3 py-2 mb-3 border rounded-md bg-gray-50 hover:bg-gray-100 transition-colors">
          {selected.length > 0 ? (
            <div className="space-y-1">
              <div className="text-xs font-medium text-gray-600 mb-2">
                Selected ({selected.length})
              </div>
              <div className="flex flex-col gap-1 max-h-20 overflow-y-auto">
                {selected.map(s => (
                  <div key={s} className="flex items-center gap-2 text-sm text-gray-800">
                    <div className="w-1.5 h-1.5 bg-blue-500 rounded-full shrink-0"></div>
                    <span className="truncate">{options.find(o => o.value === s)?.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-gray-500 text-sm">Select graders...</div>
          )}
        </div>
      </Popover>
    </div>
  );
};

export default MultiSelect;
