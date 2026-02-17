import { useState, useEffect } from 'react';
import { Button, InputNumber, Popover } from 'antd';
import { IconCalendarPlus } from '@tabler/icons-react';
import { useRevalidator } from 'react-router';
import dayjs from 'dayjs';
import useSound from 'use-sound';
import { toast } from 'react-toastify';

import { useNotifiedFetcher, useUser } from '~/hooks';
import useStore from '~/store';
import tokenImage from '~/assets/images/token.png';
import coinsSound from '~/assets/sounds/coins.mp3';

const TokenPopupForm = ({ repositoryAssignment, balance }) => {
  const [hours, setHours] = useState(1);
  const { fetcher, notify } = useNotifiedFetcher();
  const [open, setOpen] = useState(false);
  const { user } = useUser();
  const { classroom } = useStore(state => state);
  const [play] = useSound(coinsSound, { volume: 0.6 });
  const revalidator = useRevalidator();

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

  const handleOpenChange = newOpen => {
    setOpen(newOpen);
  };

  const setTime = time => {
    if (time > repositoryAssignment.num_late_hours || time < 0) return;
    setHours(time);
  };

  const onPurchaseExtensionHours = (hours, repoAssignment) => {
    // Validate all required values exist
    if (balance === null || balance === undefined) {
      toast.error('Unable to determine token balance. Please refresh the page.');
      hide();
      return;
    }

    if (!repoAssignment?.assignment?.tokens_per_hour) {
      toast.error('Token cost not configured for this assignment.');
      hide();
      return;
    }

    if (!hours || hours <= 0) {
      toast.error('Please select a valid number of hours.');
      hide();
      return;
    }

    const tokenCost = repoAssignment.assignment.tokens_per_hour * hours;
    if (balance < tokenCost) {
      toast.error(`Insufficient tokens. You need ${tokenCost} tokens but only have ${balance}.`);
      hide();
      return;
    }

    notify('PURCHASE_EXTENSION_HOURS', 'Purchased hour(s) for assignment...');
    fetcher.submit(
      {
        student_id: user.id,
        classroom_id: classroom.id,
        amount: repoAssignment.assignment.tokens_per_hour * hours * -1,
        hours_purchased: hours,
        type: 'PURCHASE',
        description: `Purchase of ${hours} hour(s).`,
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
    const tokenCost = repositoryAssignment?.assignment?.tokens_per_hour ? repositoryAssignment.assignment.tokens_per_hour * hours : 0;
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

  const hasDeadlinePassed = dayjs(repositoryAssignment.assignment.student_deadline).isBefore(dayjs());

  if (hasDeadlinePassed == false || repositoryAssignment.num_late_hours == 0) return null;

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
