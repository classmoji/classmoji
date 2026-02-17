import { roleSettings } from '~/constants/roleSettings';
import { useRole } from './useRole';

export const useRoleSettings = () => {
  const { role } = useRole();
  return roleSettings[role];
};
