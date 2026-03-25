import useStore from '~/store';

export const useUser = () => {
  const { user, setUser } = useStore((state: any) => state);
  return { user, setUser };
};
