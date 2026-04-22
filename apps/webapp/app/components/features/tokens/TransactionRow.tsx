import { Chip } from '@classmoji/ui-components';
import type { TokenTransaction } from './tokensTypes';

export const TRANSACTION_GRID_TEMPLATE = '110px 1fr 180px 90px';

interface TransactionRowProps {
  transaction: TokenTransaction;
  last?: boolean;
}

export function TransactionRow({ transaction, last }: TransactionRowProps) {
  const { type, note, when, amount } = transaction;
  const positive = amount > 0;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: TRANSACTION_GRID_TEMPLATE,
        gap: 16,
        padding: '14px 18px',
        alignItems: 'center',
        borderBottom: last ? 'none' : '1px solid var(--line)',
      }}
    >
      <span>
        {type === 'GAIN' ? (
          <Chip variant="quiz">GAIN</Chip>
        ) : type === 'SPENDING' ? (
          <Chip variant="late">SPENDING</Chip>
        ) : (
          <Chip variant="ghost">{type}</Chip>
        )}
      </span>
      <span style={{ fontSize: 13.5 }}>{note}</span>
      <span className="mono" style={{ fontSize: 12, color: 'var(--ink-3)' }}>
        {when}
      </span>
      <span
        className="mono"
        style={{
          fontSize: 14,
          fontWeight: 600,
          textAlign: 'right',
          color: positive ? 'oklch(48% 0.14 155)' : 'oklch(50% 0.17 20)',
        }}
      >
        {positive ? '+' : ''}
        {amount}
      </span>
    </div>
  );
}

export default TransactionRow;
