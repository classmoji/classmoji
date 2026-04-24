import { Input } from 'antd';
import { IconSearch } from '@tabler/icons-react';

interface SearchInputProps {
  query: string;
  setQuery: (value: string) => void;
  placeholder?: string;
  width?: string;
  className?: string;
}

const SearchInput = ({
  query,
  setQuery,
  placeholder,
  width,
  className = 'mb-6',
}: SearchInputProps) => {
  return (
    <Input
      className={className}
      style={width ? { width } : undefined}
      prefix={<IconSearch size={16} />}
      placeholder={placeholder}
      onChange={e => setQuery(e.target.value)}
      value={query}
    />
  );
};

export default SearchInput;
