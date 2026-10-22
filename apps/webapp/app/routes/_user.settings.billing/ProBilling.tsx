import { Button } from 'antd';
import { IconAlertTriangle, IconCheck, IconClock } from '@tabler/icons-react';
import dayjs from 'dayjs';
import type { ReactNode } from 'react';

/**
 * The parts of a Stripe subscription the page shows. Same shape as
 * `BillingSummary` in `ClassmojiService.billing`, which builds it.
 */
export interface BillingSummary {
  status: string;
  priceCents: number | null;
  /** Unix seconds: when the current paid month ends (next charge). */
  currentPeriodEnd: number | null;
  /** Unix seconds: when Pro ends, set only once a cancellation is scheduled. */
  endsAt: number | null;
  card: { brand: string; last4: string; expMonth: number; expYear: number } | null;
  email: string | null;
}

export type PortalFlow = 'payment_method_update' | 'subscription_cancel' | undefined;

const date = (unix: number | null) => (unix ? dayjs.unix(unix).format('MMM D, YYYY') : 'N/A');
const money = (cents: number | null) => (cents === null ? 'N/A' : `$${(cents / 100).toFixed(2)}`);
const brandName = (brand: string) =>
  brand === 'amex' ? 'American Express' : brand.charAt(0).toUpperCase() + brand.slice(1);

const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="space-y-2.5">
    <h3 className="text-base font-semibold text-ink-0">{title}</h3>
    <div className="border-t border-line divide-y divide-line">{children}</div>
  </section>
);

const Item = ({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
}) => (
  <div className="flex flex-wrap items-center justify-between gap-4 py-4">
    <div className="min-w-0">
      <div className="font-semibold text-ink-0">{label}</div>
      {hint && <div className="text-sm text-ink-2">{hint}</div>}
    </div>
    {children}
  </div>
);

const ProBadge = ({ ending, children }: { ending: boolean; children: ReactNode }) => (
  <span
    className={`ml-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold align-middle ${
      ending
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
        : 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
    }`}
  >
    <span
      aria-hidden="true"
      className={`h-1.5 w-1.5 rounded-full ${ending ? 'bg-amber-500' : 'bg-green-500'}`}
    />
    {children}
  </span>
);

/** What Pro adds over Free, the same lines as the Free page's Pro column. */
const Included = ({ lines }: { lines: string[] }) => (
  <section className="space-y-2.5">
    <h3 className="text-base font-semibold text-ink-0">Included with Pro</h3>
    <ul className="border-t border-line pt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
      {lines.map(line => (
        <li key={line} className="flex gap-2.5">
          <IconCheck
            size={18}
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-green-600 dark:text-green-500"
          />
          <span className="text-sm text-ink-1">{line}</span>
        </li>
      ))}
    </ul>
  </section>
);

/**
 * What a Pro user sees: one row per thing they come here to do, with a banner
 * on top when the plan is ending or a payment failed. Every action opens
 * Stripe's portal, straight on the task when Stripe supports it.
 */
const ProBilling = ({
  billing,
  isComped,
  proLines,
  onPortal,
}: {
  billing: BillingSummary | null;
  isComped: boolean;
  proLines: string[];
  onPortal: (flow?: PortalFlow) => void;
}) => {
  if (isComped || !billing) {
    return (
      <div className="space-y-10">
        {isComped ? (
          <div className="rounded-2xl bg-primary-50 ring-1 ring-primary-100 px-5 py-4">
            <div className="font-semibold text-primary-700 dark:text-primary-100">Pro is on us</div>
            <div className="text-sm text-primary-700 dark:text-primary-100">
              Classmoji gave your account Pro at no cost. No card needed.
            </div>
          </div>
        ) : (
          // Paid, but Stripe could not be reached for the details.
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="font-semibold text-ink-0">You are on Pro</div>
              <div className="text-sm text-ink-2">
                Your billing details could not be loaded right now. Try again in a moment.
              </div>
            </div>
            <Button onClick={() => onPortal()}>Manage in Stripe</Button>
          </div>
        )}
        <Included lines={proLines} />
      </div>
    );
  }

  const paymentFailed = billing.status === 'past_due' || billing.status === 'unpaid';

  return (
    <div className="space-y-10">
      {billing.endsAt && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-amber-50 dark:bg-amber-950/30 ring-1 ring-amber-200 dark:ring-amber-900 px-5 py-4"
        >
          <div className="flex gap-3 min-w-0">
            <IconClock size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" />
            <div>
              <div className="font-semibold text-amber-900 dark:text-amber-200">
                Pro ends on {date(billing.endsAt)}
              </div>
              <div className="text-sm text-amber-800 dark:text-amber-300">
                You cancelled. Pro features turn off in your classes after that date. Your content
                stays.
              </div>
            </div>
          </div>
          <Button type="primary" onClick={() => onPortal()}>
            Keep Pro
          </Button>
        </div>
      )}

      {paymentFailed && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-red-50 dark:bg-red-950/30 ring-1 ring-red-200 dark:ring-red-900 px-5 py-4"
        >
          <div className="flex gap-3 min-w-0">
            <IconAlertTriangle size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-red-700 dark:text-red-400" />
            <div>
              <div className="font-semibold text-red-900 dark:text-red-200">Payment failed</div>
              <div className="text-sm text-red-800 dark:text-red-300">
                We could not charge your card. Pro stays on while we retry for a few days.
              </div>
            </div>
          </div>
          <Button danger onClick={() => onPortal('payment_method_update')}>
            Update card
          </Button>
        </div>
      )}

      <Group title="Your plan">
        <Item
          label={
            <span data-onboarding="settings-billing">
              Pro
              <ProBadge ending={Boolean(billing.endsAt)}>
                {billing.endsAt ? 'Ending' : 'Active'}
              </ProBadge>
            </span>
          }
          hint="Covers every class you own"
        />
        <Item label="Price" hint="Billed monthly">
          <span className="font-semibold tabular-nums text-ink-0">
            {money(billing.priceCents)} / month
          </span>
        </Item>
        <Item
          label={billing.endsAt ? 'Access until' : 'Next payment'}
          hint={billing.endsAt ? 'No further charges' : 'Charged automatically'}
        >
          <span className="tabular-nums text-ink-0">
            {date(billing.endsAt ?? billing.currentPeriodEnd)}
          </span>
        </Item>
      </Group>

      <Included lines={proLines} />

      <Group title="Payment and receipts">
        <Item
          label={
            billing.card
              ? `${brandName(billing.card.brand)} ending in ${billing.card.last4}`
              : 'No card on file'
          }
          hint={
            billing.card
              ? `Expires ${String(billing.card.expMonth).padStart(2, '0')}/${String(billing.card.expYear).slice(-2)}`
              : undefined
          }
        >
          <Button onClick={() => onPortal('payment_method_update')}>Update card</Button>
        </Item>
        <Item label="Receipts sent to" hint={billing.email ?? 'N/A'}>
          <Button onClick={() => onPortal()}>Change</Button>
        </Item>
        <Item label="Invoices" hint="Download any past receipt">
          <Button type="link" onClick={() => onPortal()}>
            View all
          </Button>
        </Item>
      </Group>

      {!billing.endsAt && (
        <Group title="Cancel subscription">
          <Item
            label="Cancel Pro"
            hint={`Pro stays on until ${date(billing.currentPeriodEnd)}. Your classes and content are kept.`}
          >
            <Button type="primary" danger onClick={() => onPortal('subscription_cancel')}>
              Cancel plan
            </Button>
          </Item>
        </Group>
      )}
    </div>
  );
};

export default ProBilling;
