import { useState, useEffect } from 'react';
import { Button, InputNumber, Popover } from 'antd';
import { IconCalendarPlus } from '@tabler/icons-react';
import { useRevalidator } from 'react-router';
import useSound from 'use-sound';

import { useCallout } from '@classmoji/ui-components';
import { useNotifiedFetcher, useUser } from '~/hooks';
import useStore from '~/store';
import tokenImage from '~/assets/images/token.png';
import coinsSound from '~/assets/sounds/coins.mp3';

interface TokenPopupRepositoryAssignment {
  id: string;
  /** Hours still late after what was already bought; only presets the field. */
  num_late_hours: number;
  is_late_override: boolean;
  assignment: {
    tokens_per_hour?: number | null;
  };
}

interface TokenPopupFormProps {
  weight?: number;
  repositoryAssignment: TokenPopupRepositoryAssignment;
  balance: number | null | undefined;
}

/**
 * Hours can be bought at any time: ahead of the deadline, while the work is
 * late, or after it is submitted. The only limits are the ones the server
 * enforces too (token.purchaseExtensionHours): a price per hour is set, no late
 * override is in effect, and the balance covers the cost.
 */
const TokenExtensionPopover = ({ repositoryAssignment, balance }: TokenPopupFormProps) => {
  const tokensPerHour = repositoryAssignment.assignment.tokens_per_hour ?? 0;
  // The most hours the balance pays for; unknown balance leaves the field open
  // and the purchase handler reports it.
  const maxHours =
    balance === null || balance === undefined || tokensPerHour <= 0
      ? undefined
      : Math.floor(balance / tokensPerHour);
  // Start at what clears the lateness, when the student is late and can pay.
  const [hours, setHours] = useState(() =>
    Math.max(1, Math.min(repositoryAssignment.num_late_hours, maxHours ?? Infinity))
  );
  const { fetcher, notify } = useNotifiedFetcher();
  const [open, setOpen] = useState(false);
  const { user } = useUser();
  const { classroom } = useStore();
  const [play] = useSound(coinsSound, { volume: 0.6 });
  const revalidator = useRevalidator();
  const callout = useCallout();

  // Revalidate parent route data after successful purchase
  useEffect(() => {
    if (fetcher.data?.action === 'PURCHASE_EXTENSION_HOURS' && fetcher.data?.success) {
      // This will re-run the parent loader, which automatically syncs to Zustand
      revalidator.revalidate();
      // The hours just bought are no longer the ones to offer next.
      setHours(1);
    }
  }, [fetcher.data, revalidator]);

  const hide = () => {
    setOpen(false);
  };

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
  };

  const setTime = (time: number | null) => {
    if (time === null) return;
    if (time < 1 || (maxHours !== undefined && time > Math.max(1, maxHours))) return;
    setHours(time);
  };

  const onPurchaseExtensionHours = (
    purchaseHours: number,
    repoAssignment: TokenPopupRepositoryAssignment
  ) => {
    // Validate all required values exist
    if (balance === null || balance === undefined) {
      callout.show({
        variant: 'error',
        title: 'Unable to determine token balance. Please refresh the page.',
      });
      hide();
      return;
    }

    if (!repoAssignment?.assignment?.tokens_per_hour) {
      callout.show({ variant: 'error', title: 'Token cost not configured for this assignment.' });
      hide();
      return;
    }

    if (!purchaseHours || purchaseHours <= 0) {
      callout.show({ variant: 'error', title: 'Please select a valid number of hours.' });
      hide();
      return;
    }

    const tokenCost = repoAssignment.assignment.tokens_per_hour * purchaseHours;
    if (balance < tokenCost) {
      callout.show({
        variant: 'error',
        title: `Insufficient tokens. You need ${tokenCost} tokens but only have ${balance}.`,
      });
      hide();
      return;
    }

    notify('PURCHASE_EXTENSION_HOURS', 'Purchased hour(s) for assignment...');
    fetcher.submit(
      {
        student_id: user!.id,
        classroom_id: classroom!.id,
        amount: repoAssignment.assignment.tokens_per_hour * purchaseHours * -1,
        hours_purchased: purchaseHours,
        type: 'PURCHASE',
        description: `Purchase of ${purchaseHours} hour(s).`,
        git_repo_assignment_id: repoAssignment.id,
      },
      {
        method: 'post',
        action: `?action=purchaseExtensionHours`,
        encType: 'application/json',
      }
    );

    hide();

    play();
  };

  // Called, not rendered as <Form />: a component defined inside this one is a
  // new type on every render, which remounts the field and drops its focus
  // each time a digit is typed.
  const renderForm = () => {
    const tokenCost = repositoryAssignment?.assignment?.tokens_per_hour
      ? repositoryAssignment.assignment.tokens_per_hour * hours
      : 0;
    const hasInsufficientBalance = balance !== null && balance !== undefined && balance < tokenCost;

    return (
      <div className="w-[185px]">
        <div className="flex items-center gap-1">
          <p>
            {hours} hour(s) = {tokenCost} tokens
          </p>
          <img src={tokenImage} alt="token" className="h-[19px] w-[19px]" />
        </div>
        {balance !== null && balance !== undefined && (
          <p
            className={`text-sm mt-1 ${
              hasInsufficientBalance
                ? 'text-red-500 dark:text-red-400'
                : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            Balance: {balance} tokens
          </p>
        )}
        <div className="mt-4">
          <InputNumber
            addonAfter="hour(s)"
            value={hours}
            onChange={setTime}
            min={1}
            max={maxHours === undefined ? undefined : Math.max(1, maxHours)}
          />
          <Button
            className="w-full mt-4"
            onClick={() => onPurchaseExtensionHours(hours, repositoryAssignment)}
            disabled={hasInsufficientBalance || !repositoryAssignment?.assignment?.tokens_per_hour}
          >
            Purchase
          </Button>
        </div>
      </div>
    );
  };

  if (tokensPerHour <= 0 || repositoryAssignment.is_late_override) return null;

  return (
    <Popover
      title="Purchase extension hours"
      open={open}
      onOpenChange={handleOpenChange}
      content={renderForm()}
      placement="left"
      trigger="click"
    >
      {/* A real button: it opens on click or tap, and from the keyboard. */}
      <button
        type="button"
        aria-label="Buy extension hours"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-700 dark:text-gray-200 rounded-md hover:text-ink-0 dark:hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        Extend
        <IconCalendarPlus size={15.5} aria-hidden="true" />
      </button>
    </Popover>
  );
};

export default TokenExtensionPopover;
