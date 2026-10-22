import { Button } from 'antd';
import { IconCheck } from '@tabler/icons-react';

const formatPrice = (cents: number | null): string =>
  cents === null ? '' : `$${Number.isInteger(cents / 100) ? cents / 100 : (cents / 100).toFixed(2)}`;

const Feature = ({ text, accent }: { text: string; accent?: boolean }) => (
  <li className="flex gap-2.5">
    <IconCheck
      size={18}
      aria-hidden="true"
      className={`mt-0.5 shrink-0 ${accent ? 'text-green-600 dark:text-green-500' : 'text-ink-3'}`}
    />
    <span className="text-sm text-ink-1">{text}</span>
  </li>
);

/**
 * What a Free user sees: Free and Pro side by side, the upgrade on Pro, then
 * the three questions instructors ask before paying. The lines come from
 * `ClassmojiService.billing.planFeatures` through the loader.
 */
const FreePlans = ({
  freeLines,
  proLines,
  proPriceCents,
  onUpgrade,
}: {
  freeLines: string[];
  proLines: string[];
  proPriceCents: number | null;
  onUpgrade: () => void;
}) => {
  const price = formatPrice(proPriceCents);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-ink-0">Choose the plan for your classes</h2>
        <p className="text-ink-2">One plan covers every class you own. Students never pay.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-0 md:divide-x md:divide-line border-t border-line pt-6">
        <section className="flex flex-col gap-5 md:pr-8">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-ink-0">Free</h3>
            <span className="rounded-full bg-gray-100 dark:bg-neutral-800 px-2.5 py-0.5 text-xs font-medium text-ink-2">
              Your plan
            </span>
          </div>
          <p className="flex items-baseline gap-1.5">
            <span className="text-4xl font-bold text-ink-0">$0</span>
            <span className="text-ink-2">forever</span>
          </p>
          <ul className="flex flex-col gap-2.5">
            {freeLines.map(line => (
              <Feature key={line} text={line} />
            ))}
          </ul>
          <Button disabled className="mt-auto" size="large">
            Current plan
          </Button>
        </section>

        <section className="flex flex-col gap-5 md:pl-8">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-ink-0">Pro</h3>
            <span className="rounded-full bg-primary-50 px-2.5 py-0.5 text-xs font-medium text-primary-700 dark:text-primary-100">
              For instructors
            </span>
          </div>
          <p className="flex items-baseline gap-1.5">
            <span className="text-4xl font-bold text-ink-0">{price || 'Pro'}</span>
            {price && <span className="text-ink-2">per month, all your classes</span>}
          </p>
          <ul className="flex flex-col gap-2.5">
            <li className="text-sm text-ink-2">Everything in Free, plus:</li>
            {proLines.map(line => (
              <Feature key={line} text={line} accent />
            ))}
          </ul>
          <Button type="primary" size="large" className="mt-auto" onClick={onUpgrade}>
            Upgrade to Pro
          </Button>
        </section>
      </div>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-5 border-t border-line pt-6">
        <div>
          <h4 className="font-semibold text-ink-0">Who pays?</h4>
          <p className="text-sm text-ink-2">
            You do, once, for all the classes you own. Co-owners of a class share it.
          </p>
        </div>
        <div>
          <h4 className="font-semibold text-ink-0">Can I expense it?</h4>
          <p className="text-sm text-ink-2">Each month you get a receipt by email.</p>
        </div>
        <div>
          <h4 className="font-semibold text-ink-0">What if I cancel?</h4>
          <p className="text-sm text-ink-2">
            Pro stays on until the end of the month you paid for. Nothing is deleted.
          </p>
        </div>
      </section>
    </div>
  );
};

export default FreePlans;
