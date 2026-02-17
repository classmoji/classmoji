import { routes } from '~/constants/routes';

const PageHeader = ({ title, routeName, children }) => {
  const IconComponent = routes[routeName].icon;

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2 mt-2 mb-4">
        <IconComponent className="text-black dark:text-gray-200" />
        <h1 className="text-2xl font-bold text-black dark:text-gray-200">{title}</h1>
      </div>
      {children}
    </div>
  );
};

export default PageHeader;
