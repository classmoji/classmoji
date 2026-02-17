import useStore from '~/store';

export const useRole = () => {
  const { role, setRole } = useStore(state => state);
  return { role, setRole };
};
