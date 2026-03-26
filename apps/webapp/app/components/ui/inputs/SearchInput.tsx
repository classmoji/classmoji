import { Input } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { IconSearch } from '@tabler/icons-react';

interface SearchInputProps {
  query: string;
  setQuery: (value: string) => void;
  placeholder?: string;
  width?: string;
  className?: string;
}

const SearchInput = ({ query, setQuery, placeholder, width = '350px' }: SearchInputProps) => {
  return (
    <Input
      className={`mb-6`}
      style={{ width: width }}
      prefix={<IconSearch size={16} />}
      placeholder={placeholder}
      onChange={e => setQuery(e.target.value)}
      value={query}
    />
  );
};

export default SearchInput;
