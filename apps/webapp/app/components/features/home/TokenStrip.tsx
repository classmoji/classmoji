import { Link } from 'react-router';
import { IconArrowR, IconCoin } from '@classmoji/ui-components';

export interface TokenStripData {
  balance: number;
  earned: number;
  spent: number;
}

interface TokenStripProps {
  tokens: TokenStripData;
  tokensHref: string;
}

export function TokenStrip({ tokens, tokensHref }: TokenStripProps) {
  return (
    <div
      className="card"
      style={{
        padding: 18,
        background: 'linear-gradient(135deg, oklch(98% 0.02 80) 0%, white 60%)',
        borderColor: 'oklch(93% 0.04 80)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 10,
        }}
      >
        <span style={{ color: 'oklch(62% 0.15 80)' }}>
          <IconCoin size={18} />
        </span>
        <span className="caps">Tokens</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span
          className="display"
          style={{ fontSize: 40, fontWeight: 500, letterSpacing: -1, lineHeight: 1 }}
        >
          {tokens.balance}
        </span>
        <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>available</span>
      </div>
      <div
        style={{
          display: 'flex',
          gap: 14,
          marginTop: 12,
          fontSize: 11.5,
          color: 'var(--ink-2)',
        }}
        className="mono"
      >
        <span>↑ {tokens.earned} earned</span>
        <span>↓ {tokens.spent} spent</span>
      </div>
      <Link
        to={tokensHref}
        className="btn"
        style={{
          width: '100%',
          marginTop: 14,
          textDecoration: 'none',
          justifyContent: 'center',
        }}
      >
        Spend tokens <IconArrowR size={14} />
      </Link>
    </div>
  );
}

export default TokenStrip;
