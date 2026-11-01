import { Input } from 'antd';
import { IconSearch } from '@tabler/icons-react';

interface SearchInputProps {
  query: string;
  setQuery: (value: string) => void;
  placeholder?: string;
  width?: string;
  className?: string;
  /** Accessible name, for when the placeholder is too short to describe the search. */
  ariaLabel?: string;
  /** Id of a visible hint that explains what the search matches. */
  describedBy?: string;
}

const SearchInput = ({
  query,
  setQuery,
  placeholder,
  width,
  className = 'mb-6',
  ariaLabel,
  describedBy,
}: SearchInputProps) => {
  return (
    <Input
      className={className}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      style={width ? { width } : undefined}
      prefix={<IconSearch size={16} />}
      placeholder={placeholder}
      onChange={e => setQuery(e.target.value)}
      value={query}
    />
  );
};

export default SearchInput;
