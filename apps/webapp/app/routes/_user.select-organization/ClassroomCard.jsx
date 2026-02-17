import { motion } from 'framer-motion';

const ClassroomCard = ({ classroom, role }) => {
  const getRoleBadgeStyles = role => {
    switch (role) {
      case 'OWNER':
        return 'text-red-700 bg-red-50 border-red-200 hover:bg-red-100 dark:text-red-300 dark:bg-red-900/20 dark:border-red-800 dark:hover:bg-red-900/30';
      case 'ASSISTANT':
        return 'text-blue-700 bg-blue-50 border-blue-200 hover:bg-blue-100 dark:text-blue-300 dark:bg-blue-900/20 dark:border-blue-800 dark:hover:bg-blue-900/30';
      case 'STUDENT':
        return 'text-green-700 bg-green-50 border-green-200 hover:bg-green-100 dark:text-green-300 dark:bg-green-900/20 dark:border-green-800 dark:hover:bg-green-900/30';
      case 'PENDING INVITE':
        return 'text-gray-600 bg-gray-50 border-gray-200 hover:bg-gray-100 dark:text-gray-400 dark:bg-gray-800 dark:border-gray-700 dark:hover:bg-gray-700';
      default:
        return 'text-gray-600 bg-gray-50 border-gray-200 hover:bg-gray-100 dark:text-gray-400 dark:bg-gray-800 dark:border-gray-700 dark:hover:bg-gray-700';
    }
  };

  return (
    <motion.div
      whileHover={{
        scale: 1.02,
        y: -2,
      }}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        type: 'spring',
        stiffness: 400,
        damping: 30,
        duration: 0.2,
      }}
    >
      <div className="shadow-md hover:shadow-xl border border-gray-200 dark:border-gray-700 rounded-lg transition-shadow duration-200 group bg-white dark:bg-gray-800">
        <div className="h-[6px] bg-primary rounded-t-lg" />
        <div className="text-slate-800 dark:text-slate-200 flex justify-between p-4 h-[110px]">
          <div className="flex flex-col justify-start gap-2">
            {classroom.name && (
              <h2 className="text-lg font-bold text-left group-hover:text-slate-900 dark:group-hover:text-slate-100 transition-colors duration-200 font-header">
                {classroom.name}
              </h2>
            )}
            <h4
              className={`text-${
                classroom.name ? 'md' : 'lg'
              } text-slate-600 dark:text-slate-400 text-start`}
            >
              @{classroom.git_organization?.login || classroom.login}
            </h4>
          </div>

          <div>
            <img
              src={classroom.git_organization?.avatar_url || classroom.avatar_url}
              alt={classroom.git_organization?.login || classroom.login}
              className="h-[40px] w-[40px] rounded-full border-2 border-gray-200 dark:border-gray-600 group-hover:border-gray-300 dark:group-hover:border-gray-500 transition-colors duration-200"
            />
          </div>
        </div>
        <div className="flex justify-between p-4 font-bold text-black dark:text-white">
          <div
            className={`text-xs font-medium py-1 px-2 rounded-lg border transition-colors duration-200 ${getRoleBadgeStyles(
              role
            )}`}
          >
            {role}
          </div>
        </div>
      </div>
    </motion.div>
  );
};

export default ClassroomCard;
