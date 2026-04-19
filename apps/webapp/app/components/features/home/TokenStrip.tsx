import { Link } from 'react-router';

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
    <div className="panel flex items-center gap-3 px-4 py-3">
      <span className="caps text-[10px]">Tokens</span>
      <span className="display num text-[22px] font-medium leading-none -tracking-[0.5px]">
        {tokens.balance}
      </span>
      <div className="flex items-baseline gap-3 text-[11.5px] text-ink-2 mono">
        <span>↑ {tokens.earned} earned</span>
        <span>↓ {tokens.spent} spent</span>
      </div>
      <div className="flex-1" />
      <Link to={tokensHref} className="btn btn-sm no-underline">
        View tokens →
      </Link>
    </div>
  );
}

export default TokenStrip;
