const ButtonIcon = ({ action, icon }) => {
  const Icon = icon;
  return (
    <button
      className="h-[33px] w-[33px] border rounded-md border-iron bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 flex justify-center items-center cursor-pointer transition-colors"
      onClick={action}
    >
      <Icon className="w-5 h-5 text-gray-600 dark:text-gray-400" />
    </button>
  );
};

export default ButtonIcon;
