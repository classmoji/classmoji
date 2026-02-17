import { useState, useEffect } from 'react';
import { Octokit } from '@octokit/rest';
import { FormItem } from 'react-hook-form-antd';
import { Select, Input, Spin } from 'antd';
import { useDebounce } from '@uidotdev/usehooks';

const getAsyncData = async (query, token) => {
  try {
    // Search for public template repositories using GitHub's search API
    const octokit = new Octokit({ auth: token });

    const searchQuery = query + ' in:name is:public';

    const response = await octokit.rest.search.repos({
      q: searchQuery,
      sort: 'updated',
      order: 'desc',
      per_page: 50,
    });

    return response.data.items;
  } catch (error) {
    console.error('Error searching public templates:', error);
    return [];
  }
};

const AsyncAutocomplete = ({ template, isPublished, setTemplate, control, token }) => {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [query, setQuery] = useState('');
  const [value, setValue] = useState(template);

  // Debounce the search query to avoid excessive API calls
  const debouncedQuery = useDebounce(query, 500);

  useEffect(() => {
    if (debouncedQuery && debouncedQuery.length >= 2) {
      fetchOptions(debouncedQuery);
    } else if (debouncedQuery.length === 0) {
      setData(null);
    }
  }, [debouncedQuery]);

  const fetchOptions = async q => {
    setLoading(true);
    try {
      const result = await getAsyncData(q, token);
      const repos = result;
      setData(repos);
    } catch (error) {
      console.error('Error fetching repositories:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-3 mb-8">
      {isPublished ? (
        <Input className="mb-1" value={template} readOnly />
      ) : (
        <div className="flex gap-2">
          <FormItem
            name="template"
            label="Search Public Template Repositories"
            className="w-full"
            control={control}
          >
            <Select
              className="w-full"
              placeholder="Type to search public template repositories..."
              loading={loading}
              value={value}
              onSelect={v => {
                setValue(v);
                setTemplate(v);
              }}
              onSearch={setQuery}
              showSearch
              filterOption={false}
              notFoundContent={
                loading ? (
                  <div className="text-center py-4">
                    <Spin size="small" />{' '}
                    <span className="ml-2">Searching public templates...</span>
                  </div>
                ) : query ? (
                  'No template repositories found'
                ) : (
                  'Type to search for public template repositories'
                )
              }
              options={(data || []).map(d => ({
                value: d.full_name,
                label: (
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium">{d.full_name}</div>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      {d.stargazers_count > 0 && <span>⭐{d.stargazers_count}</span>}
                      {d.language && <span>{d.language}</span>}
                    </div>
                  </div>
                ),
              }))}
            />
          </FormItem>
        </div>
      )}

      {isPublished && (
        <p className="text-sm text-blue-500 pt-1">
          NOTE: Template repo cannot be changed for published assignments.
        </p>
      )}
    </div>
  );
};

export default AsyncAutocomplete;
