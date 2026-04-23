import { Table, Tag, Avatar, Button } from 'antd';
import dayjs from 'dayjs';
import { IconCoin } from '@tabler/icons-react';

import { useRole, useGlobalFetcher } from '~/hooks';

const colors: Record<string, string> = {
  PURCHASE: 'red',
  GAIN: 'green',
  REMOVAL: 'orange',
  REFUND: 'blue',
};

interface TokenTransaction {
  id: string;
  type: string;
  is_cancelled: boolean;
  student_id: string;
  classroom_id: string;
  student: Record<string, unknown>;
  created_at: string | Date;
  amount: number;
  [key: string]: unknown;
}

interface TokensLogProps {
  transactions: TokenTransaction[];
  students?: Array<{ id: string; name: string | null }>;
  [key: string]: unknown;
}

const TokensLog = ({ transactions, students }: TokensLogProps) => {
  const { role } = useRole();
  const { fetcher, notify } = useGlobalFetcher();

  const onCancelTransaction = (transaction: TokenTransaction) => {
    notify('CANCEL_TOKEN_TRANSACTION', 'Cancelling transaction...');

    fetcher!.submit(
      {
        transaction: {
          id: transaction.id,
          classroom_id: transaction.classroom_id,
          student_id: transaction.student_id,
          type: transaction.type,
          amount: transaction.amount,
        },
      },
      {
        method: 'post',
        action: `/api/operation/?action=cancelTokenTransaction`,
        encType: 'application/json',
      }
    );
  };

  const columns = [
    {
      title: 'Type',
      key: 'type',
      width: 120,
      filters: [
        { text: 'Purchase', value: 'PURCHASE' },
        { text: 'Gain', value: 'GAIN' },
        { text: 'Removal', value: 'REMOVAL' },
        { text: 'Refund', value: 'REFUND' },
      ],
      onFilter: (value: unknown, record: TokenTransaction) => record.type === value,
      render: (_: unknown, record: TokenTransaction) => {
        const type = record.type as string;
        return (
          <div className="flex items-center gap-2">
            <Tag color={colors[type]} bordered={false}>
              {type.charAt(0).toUpperCase() + type.slice(1).toLowerCase()}
            </Tag>
            {record.is_cancelled && <span className="text-red-500 text-xs">Cancelled</span>}
          </div>
        );
      },
    },
    {
      title: 'Student',
      dataIndex: 'student',
      key: 'student',
      hidden: role === 'STUDENT',
      width: 250,
      filters: (students || []).map((student: { id: string; name: string | null }) => ({
        text: student.name,
        value: student.id,
      })),
      filterSearch: true,
      onFilter: (value: unknown, record: TokenTransaction) => record.student_id === value,
      render: (student: Record<string, unknown>) => {
        return (
          <div className="flex items-center gap-2">
            <Avatar src={student.avatar_url as string} size={24} />
            <span className="truncate">{student.name as string}</span>
          </div>
        );
      },
    },
    {
      title: 'Request Date',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 200,
      render: (date: string) => dayjs(date).format('MMM DD, YYYY [at] hh:mm A'),
    },
    {
      title: 'Amount',
      dataIndex: 'amount',
      key: 'amount',
      width: 100,
      render: (amount: number, record: TokenTransaction) => {
        const isSpent = record.type === 'PURCHASE' || record.type === 'REMOVAL';
        const color = colors[record.type as string];
        return (
          <div className="flex items-center gap-1">
            <IconCoin size={16} color={color} />
            <span className="" style={{ color }}>
              {isSpent ? '-' : '+'} {Math.abs(amount)}
            </span>
          </div>
        );
      },
    },
    {
      title: 'Hours',
      dataIndex: 'hours_purchased',
      key: 'hours_purchased',
      width: 100,
    },
    {
      title: 'Balance',
      dataIndex: 'balance_after',
      key: 'balance_after',
    },
    {
      title: 'Assignment',
      dataIndex: ['repository_issue', 'assignment', 'title'],
      key: 'assignment',
      width: 300,
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      width: 300,
    },
    {
      title: 'Action(s)',
      key: 'actions',
      hidden: role !== 'STUDENT',
      render: (transaction: TokenTransaction) => {
        if (transaction.is_cancelled) return null;
        if (transaction.type !== 'PURCHASE') return null;

        return (
          <Button
            type="link"
            danger
            className="pl-0"
            onClick={() => onCancelTransaction(transaction)}
            disabled={fetcher!.state === 'loading' || fetcher!.state === 'submitting'}
          >
            Cancel
          </Button>
        );
      },
    },
  ];

  return (
    <Table
      dataSource={transactions}
      columns={columns}
      rowHoverable={false}
      size="small"
      pagination={{ defaultPageSize: 20 }}
      rowKey={record => (record as unknown as Record<string, string>).id}
      locale={{
        emptyText: (
          <div className="text-center py-8 text-gray-500">
            <div className="text-4xl mb-2">🪙</div>
            <div>No token transactions yet</div>
            <div className="text-sm">
              Token transactions will appear here once students make purchases or spend tokens
            </div>
          </div>
        ),
      }}
    />
  );
};

export default TokensLog;
