interface SettingSectionProps {
  children: React.ReactNode;
  title: string;
  description?: string;
  extra?: React.ReactNode;
}

const SettingSection = ({ children, title, description, extra }: SettingSectionProps) => {
  return (
    <div className="flex py-6 gap-16">
      <div className="w-[400px]">
        <h1 className="font-bold pb-2">{title}</h1>
        <p className="text-gray-500 text-sm">{description}</p>
        {extra && <p className="text-red-500 pt-3">{extra}</p>}
      </div>
      <div className="w-full">{children}</div>
    </div>
  );
};

export default SettingSection;
