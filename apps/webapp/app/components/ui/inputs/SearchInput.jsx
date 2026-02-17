import { Input } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { IconSearch } from '@tabler/icons-react';

const SearchInput = ({ query, setQuery, placeholder, width = '350px' }) => {
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
