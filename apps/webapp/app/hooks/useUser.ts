import useStore from '~/store';

export const useUser = () => {
  const { user, setUser } = useStore();
  return { user, setUser };
};
