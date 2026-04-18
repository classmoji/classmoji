import { Button, IconArrowR } from '@classmoji/ui-components';

interface WalletHeroProps {
  balance: number;
  earned: number;
  spent: number;
  /** String rate like "10 : 1h". Defaults to "10 : 1h". */
  exchangeRate?: string;
  /** When provided, a "Spend on extension" CTA is rendered. */
  onSpend?: () => void;
}

export function WalletHero({
  balance,
  earned,
  spent,
  exchangeRate = '10 : 1h',
  onSpend,
}: WalletHeroProps) {
  return (
    <div
      className="card"
      style={{
        padding: 30,
        position: 'relative',
        overflow: 'hidden',
        background:
          'linear-gradient(135deg, oklch(98% 0.03 80) 0%, oklch(97% 0.05 40) 100%)',
        borderColor: 'oklch(92% 0.06 60)',
      }}
    >
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: -40,
          right: -40,
          width: 200,
          height: 200,
          background:
            'radial-gradient(circle, oklch(90% 0.12 60 / 0.4), transparent 70%)',
          pointerEvents: 'none',
        }}
      />
      <div className="caps">Wallet</div>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          marginTop: 4,
        }}
      >
        <span
          className="display"
          style={{
            fontSize: 72,
            fontWeight: 400,
            letterSpacing: -2,
            lineHeight: 1,
          }}
        >
          {balance}
        </span>
        <span style={{ fontSize: 20 }}>🪙</span>
        <span style={{ fontSize: 14, color: 'var(--ink-2)' }}>
          tokens available
        </span>
      </div>
      <div style={{ display: 'flex', gap: 20, marginTop: 20, alignItems: 'center' }}>
        <div>
          <div className="caps">Earned</div>
          <div
            className="mono"
            style={{ fontSize: 20, fontWeight: 500, color: 'oklch(55% 0.14 155)' }}
          >
            +{earned}
          </div>
        </div>
        <div>
          <div className="caps">Spent</div>
          <div
            className="mono"
            style={{ fontSize: 20, fontWeight: 500, color: 'oklch(55% 0.17 20)' }}
          >
            −{spent}
          </div>
        </div>
        <div>
          <div className="caps">Exchange</div>
          <div className="mono" style={{ fontSize: 20, fontWeight: 500 }}>
            {exchangeRate}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        {onSpend ? (
          <Button variant="primary" onClick={onSpend} style={{ alignSelf: 'center' }}>
            Spend on extension <IconArrowR size={14} />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export default WalletHero;
