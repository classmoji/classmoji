import { WalletHero } from './WalletHero';
import { TransactionRow } from './TransactionRow';
import type { TokenTransaction } from './tokensTypes';

interface TokensScreenProps {
  balance: number;
  earned: number;
  spent: number;
  transactions: TokenTransaction[];
  exchangeRate?: string;
  onSpend?: () => void;
}

export function TokensScreen({
  balance,
  earned,
  spent,
  transactions,
  exchangeRate,
  onSpend,
}: TokensScreenProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <WalletHero
        balance={balance}
        earned={earned}
        spent={spent}
        exchangeRate={exchangeRate}
        onSpend={onSpend}
      />

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600 }}>Transaction history</div>
        </div>
        {transactions.length === 0 ? (
          <div
            style={{
              padding: '28px 18px',
              textAlign: 'center',
              color: 'var(--ink-3)',
              fontSize: 13,
            }}
          >
            No token transactions yet.
          </div>
        ) : (
          transactions.map((tx, i) => (
            <TransactionRow
              key={tx.id}
              transaction={tx}
              last={i === transactions.length - 1}
            />
          ))
        )}
      </div>
    </div>
  );
}

export default TokensScreen;
