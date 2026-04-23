import { roleSettings } from '~/constants/roleSettings';
import { useRole } from './useRole';

export const useRoleSettings = () => {
  const { role } = useRole();
  if (!role) return undefined;
  return roleSettings[role as keyof typeof roleSettings];
};
