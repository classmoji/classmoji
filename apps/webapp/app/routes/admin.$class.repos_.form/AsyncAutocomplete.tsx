import { useState, useEffect } from 'react';
import type { Control, FieldValues } from 'react-hook-form';
import { FormItem } from 'react-hook-form-antd';
import { Select, Input, Spin, Tag } from 'antd';
import { useDebounce } from '@uidotdev/usehooks';

interface TemplateRepository {
  name: string;
  full_name: string;
  description: string | null;
  updated_at: string | null;
  private: boolean;
  language: string | null;
  stargazers_count: number;
}

// Search the classroom org's repos (public + private) plus global public repos
// via the server endpoint, which uses the org installation token. The
// installation token is never exposed to the browser.
const getAsyncData = async (query: string, classSlug: string): Promise<TemplateRepository[]> => {
  try {
    const params = new URLSearchParams({ classroomSlug: classSlug, q: query });
    const response = await fetch(`/api/github-repos?${params.toString()}`);

    if (!response.ok) {
      console.error('Error searching templates:', response.status);
      return [];
    }

    const data = (await response.json()) as TemplateRepository[] | { error: string };
    return Array.isArray(data) ? data : [];
  } catch (error: unknown) {
    console.error('Error searching templates:', error);
    return [];
  }
};

interface AsyncAutocompleteProps {
  template: string;
  isPublished: boolean;
  setTemplate: (template: string) => void;
  control: Control<FieldValues>;
  classSlug: string;
}

const AsyncAutocomplete = ({
  template,
  isPublished,
  setTemplate,
  control,
  classSlug,
}: AsyncAutocompleteProps) => {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<TemplateRepository[] | null>(null);
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

  const fetchOptions = async (q: string) => {
    setLoading(true);
    try {
      const result = await getAsyncData(q, classSlug);
      setData(result);
    } catch (error: unknown) {
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
            label="Search template repositories"
            className="w-full"
            control={control}
          >
            <Select
              className="w-full"
              placeholder="Type to search template repositories..."
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
                    <Spin size="small" /> <span className="ml-2">Searching templates...</span>
                  </div>
                ) : query ? (
                  'No template repositories found'
                ) : (
                  'Type to search for template repositories'
                )
              }
              options={(data || []).map(d => ({
                value: d.full_name,
                label: (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{d.full_name}</span>
                      {d.private && (
                        <Tag color="gold" className="m-0">
                          Private
                        </Tag>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      {Number(d.stargazers_count) > 0 && (
                        <span>⭐{String(d.stargazers_count)}</span>
                      )}
                      {Boolean(d.language) && <span>{String(d.language)}</span>}
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
