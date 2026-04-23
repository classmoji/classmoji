const variants: Record<string, string> = {
  positive: 'bg-green-600 dark:bg-green-700 text-white',
  negative: 'bg-red-600 dark:bg-red-700 text-white',
  neutral: 'bg-sky-600 dark:bg-sky-700 text-white',
};

interface LabelProps {
  children: React.ReactNode;
  color: string;
}

const Label = ({ children, color }: LabelProps) => {
  return (
    <div
      className={`block px-[2px] py-[3px] min-w-[80px] ${variants[color]} text-xs font-bold text-center rounded-md`}
    >
      {children}
    </div>
  );
};

export default Label;
