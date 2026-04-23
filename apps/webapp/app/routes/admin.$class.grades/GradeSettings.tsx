import { Card, Input, Table } from 'antd';
import type { ChangeEvent } from 'react';

interface LetterGradeMapping {
  letter_grade: string;
  min_grade: number;
}

interface GradeSettingsProps {
  letterGradeMappings: LetterGradeMapping[];
  changeLetterGradeMapping: (letterGrade: string, minGrade: number) => void;
}

const GradeSettings = ({ letterGradeMappings, changeLetterGradeMapping }: GradeSettingsProps) => {
  const columns = [
    {
      title: 'Letter',
      dataIndex: 'letter_grade',
      key: 'letter_grade',
      width: '50%',
      render: (_: unknown, record: LetterGradeMapping) => {
        return <p>{record.letter_grade}</p>;
      },
    },
    {
      title: 'Grade',
      dataIndex: 'min_grade',
      key: 'min_grade',
      render: (_: unknown, record: LetterGradeMapping) => {
        return (
          <GradeInput
            grade={record.min_grade}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              if (isNaN(Number(e.target.value))) {
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

interface GradeInputProps {
  grade: number;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}

const GradeInput = ({ grade, onChange }: GradeInputProps) => {
  return <Input defaultValue={grade} variant="borderless" onChange={onChange} type="number" />;
};

export default GradeSettings;
