import { Table, Checkbox, Tag, Empty } from 'antd';

const ModuleImportTable = ({
  modules,
  selectedModules,
  onModuleToggle,
  onQuizToggle,
}) => {
  if (!modules || modules.length === 0) {
    return (
      <Empty
        description="This classroom has no modules to import"
        className="py-8"
      />
    );
  }

  const columns = [
    {
      title: '',
      dataIndex: 'selected',
      width: 50,
      render: (_, record) => (
        <Checkbox
          checked={selectedModules.has(record.id)}
          onChange={e => onModuleToggle(record.id, e.target.checked)}
        />
      ),
    },
    {
      title: 'Module',
      dataIndex: 'title',
      render: (title, record) => (
        <div>
          <div className="font-medium">{title}</div>
          <div className="text-xs text-gray-500">{record.template}</div>
        </div>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'type',
      width: 100,
      render: type => (
        <Tag color={type === 'GROUP' ? 'blue' : 'green'}>
          {type}
        </Tag>
      ),
    },
    {
      title: 'Assignments',
      dataIndex: ['_count', 'assignments'],
      width: 100,
      align: 'center',
      render: count => count || 0,
    },
    {
      title: 'Quizzes',
      dataIndex: ['_count', 'quizzes'],
      width: 100,
      align: 'center',
      render: count => count || 0,
    },
    {
      title: 'Include Quizzes',
      dataIndex: 'includeQuizzes',
      width: 120,
      align: 'center',
      render: (_, record) => {
        const config = selectedModules.get(record.id);
        const hasQuizzes = (record._count?.quizzes || 0) > 0;
        return (
          <Checkbox
            disabled={!selectedModules.has(record.id) || !hasQuizzes}
            checked={config?.includeQuizzes || false}
            onChange={e => onQuizToggle(record.id, e.target.checked)}
          />
        );
      },
    },
  ];

  return (
    <Table
      dataSource={modules}
      columns={columns}
      rowKey="id"
      pagination={false}
      size="small"
      className="border border-gray-200 dark:border-gray-700 rounded-lg"
    />
  );
};

export default ModuleImportTable;
