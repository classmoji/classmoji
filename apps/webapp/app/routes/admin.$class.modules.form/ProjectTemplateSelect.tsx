import { useState, useEffect } from 'react';
import { Select, Spin, Alert } from 'antd';
import { useParams } from 'react-router';

/**
 * Dropdown to select a GitHub Project template from the organization
 */
const ProjectTemplateSelect = ({ value, onChange, disabled }: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any -- Ant Design Select onChange signature varies
  const { class: classSlug } = useParams();
  const [loading, setLoading] = useState(false);
  const [projects, setProjects] = useState<Array<{ id: string; title: string; number: number }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchProjects = async () => {
      if (!classSlug) return;

      setLoading(true);
      setError(null);

      try {
        const response = await fetch(`/api/github/projects/${classSlug}`);

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Failed to fetch projects');
        }

        const data = await response.json();
        setProjects(data.projects || []);
      } catch (err: unknown) {
        console.error('Error fetching projects:', err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };

    fetchProjects();
  }, [classSlug]);

  if (error) {
    return <Alert type="warning" message={error} className="mb-2" />;
  }

  return (
    <Select
      placeholder="Select a project template (optional)..."
      loading={loading}
      disabled={disabled}
      allowClear
      value={value}
      onChange={onChange}
      notFoundContent={loading ? <Spin size="small" /> : 'No projects found'}
      options={projects.map(p => ({
        value: p.id, // node_id
        label: (
          <div className="flex items-center justify-between">
            <span>{p.title}</span>
            <span className="text-gray-400 text-xs ml-2">#{p.number}</span>
          </div>
        ),
        title: p.title, // Store title for later use
      }))}
      optionFilterProp="title"
      showSearch
    />
  );
};

export default ProjectTemplateSelect;
