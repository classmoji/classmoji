import useStore from '~/store';

export const useUser = () => {
  const { user, setUser } = useStore(state => state);
  return { user, setUser };
};
