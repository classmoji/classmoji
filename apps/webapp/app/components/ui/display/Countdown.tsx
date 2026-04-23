import dayjs from 'dayjs';

interface CountdownProps {
  deadline?: string | Date | null;
}

const Countdown = ({ deadline }: CountdownProps) => {
  if (!deadline) return null;

  return (
    <div className="italic flex flex-col gap-2">
      <p> {dayjs(deadline).format('MMM DD, YYYY [at] h:mm A')}</p>
    </div>
  );
};

export default Countdown;
