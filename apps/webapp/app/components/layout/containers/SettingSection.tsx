interface SettingSectionProps {
  children: React.ReactNode;
  title: string;
  description?: string;
  extra?: React.ReactNode;
}

const SettingSection = ({ children, title, description, extra }: SettingSectionProps) => {
  return (
    <div className="py-6">
      <div className="flex flex-col gap-6 transition-[gap] duration-200 md:flex-row">
        <div className="w-full shrink-0 transition-[width,max-width,min-width] duration-200 md:w-[33%] md:max-w-[400px] md:min-w-[140px]">
          <h1 className="pb-2 font-bold text-gray-900 dark:text-gray-100">{title}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">{description}</p>
          {extra && <p className="pt-3 text-red-500 dark:text-red-400">{extra}</p>}
        </div>
        <div className="w-full min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
};

export default SettingSection;
