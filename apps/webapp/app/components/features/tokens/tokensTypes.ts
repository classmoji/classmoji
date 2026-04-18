export type TokenTransactionKind = 'GAIN' | 'SPENDING' | 'OTHER';

export interface TokenTransaction {
  id: string;
  type: TokenTransactionKind;
  note: string;
  when: string;
  amount: number;
}
