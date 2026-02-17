import { Card, Input, Table } from 'antd';

const GradeSettings = ({ letterGradeMappings, changeLetterGradeMapping }) => {
  const columns = [
    {
      title: 'Letter',
      dataIndex: 'letter_grade',
      key: 'letter_grade',
      width: '50%',
      render: (_, record) => {
        return <p>{record.letter_grade}</p>;
      },
    },
    {
      title: 'Grade',
      dataIndex: 'min_grade',
      key: 'min_grade',
      render: (_, record) => {
        return (
          <GradeInput
            grade={record.min_grade}
            onChange={e => {
              if (isNaN(e.target.value)) {
                return;
              }
              changeLetterGradeMapping(record.letter_grade, parseInt(e.target.value));
            }}
          />
        );
      },
    },
  ];

  return (
    <div className="">
      <Card className="w-[210px] shadow-xl z-10" size="small">
        <Table
          dataSource={letterGradeMappings}
          columns={columns}
          size="small"
          pagination={false}
          rowHoverable={false}
        />
      </Card>
    </div>
  );
};

const GradeInput = ({ grade, onChange }) => {
  return <Input defaultValue={grade} variant="borderless" onChange={onChange} type="number" />;
};

export default GradeSettings;
