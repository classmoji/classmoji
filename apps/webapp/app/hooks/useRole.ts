import useStore from '~/store';

export const useRole = () => {
  const { role, setRole } = useStore();
  return { role, setRole };
};
