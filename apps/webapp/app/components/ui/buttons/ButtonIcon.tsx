interface ButtonIconProps {
  action: () => void;
  icon: React.ComponentType<{ className?: string }>;
}

const ButtonIcon = ({ action, icon }: ButtonIconProps) => {
  const Icon = icon;
  return (
    <button
      className="h-8 w-8 border rounded-lg border-line bg-panel hover:bg-panel-hover flex justify-center items-center cursor-pointer transition-colors"
      onClick={action}
    >
      <Icon className="w-5 h-5 text-ink-2" />
    </button>
  );
};

export default ButtonIcon;
