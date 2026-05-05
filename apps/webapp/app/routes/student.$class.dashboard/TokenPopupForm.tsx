import { useState, useEffect } from 'react';
import { Button, InputNumber, Popover } from 'antd';
import { IconCalendarPlus } from '@tabler/icons-react';
import { useRevalidator } from 'react-router';
import dayjs from 'dayjs';
import useSound from 'use-sound';

import { useCallout } from '@classmoji/ui-components';
import { useNotifiedFetcher, useUser } from '~/hooks';
import useStore from '~/store';
import tokenImage from '~/assets/images/token.png';
import coinsSound from '~/assets/sounds/coins.mp3';

interface TokenPopupRepositoryAssignment {
  id: string;
  num_late_hours: number;
  is_late_override: boolean;
  assignment: {
    student_deadline: string | Date;
    tokens_per_hour?: number | null;
  };
}

interface TokenPopupFormProps {
  weight?: number;
  repositoryAssignment: TokenPopupRepositoryAssignment;
  balance: number | null | undefined;
}

const TokenPopupForm = ({ repositoryAssignment, balance }: TokenPopupFormProps) => {
  const [hours, setHours] = useState(1);
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
    if (time > repositoryAssignment.num_late_hours || time < 0) return;
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
        repository_assignment_id: repoAssignment.id,
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

  const Form = () => {
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
            className={`text-sm mt-1 ${hasInsufficientBalance ? 'text-red-500' : 'text-gray-500'}`}
          >
            Balance: {balance} tokens
          </p>
        )}
        <div className="mt-4">
          <InputNumber addonAfter="hour(s)" value={hours} onChange={setTime} min={1} />
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

  const hasDeadlinePassed = dayjs(repositoryAssignment.assignment.student_deadline).isBefore(
    dayjs()
  );

  if (
    hasDeadlinePassed == false ||
    repositoryAssignment.num_late_hours == 0 ||
    repositoryAssignment.is_late_override
  )
    return null;

  return (
    <Popover
      title="Purchase extension hours"
      open={open}
      onOpenChange={handleOpenChange}
      content={<Form />}
      placement="left"
    >
      <IconCalendarPlus className="cursor-pointer" size={15.5} />
    </Popover>
  );
};

export default TokenPopupForm;
