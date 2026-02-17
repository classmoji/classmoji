import { useEffect } from 'react';
import { useDisclosure, usePrevious } from '@mantine/hooks';
import { useNavigate } from 'react-router';
import { useWindowSize } from '@uidotdev/usehooks';

export const useRouteDrawer = ({ initialOpen = false, navigateBack = true }) => {
  const [opened, { open, close }] = useDisclosure(initialOpen);
  const navigate = useNavigate();
  const previousOpened = usePrevious(opened);
  const { width } = useWindowSize();

  // Open the drawer on initial mount
  useEffect(() => {
    open();
  }, []);

  // Navigate back when the drawer closes
  useEffect(() => {
    if (navigateBack && previousOpened && !opened) {
      navigate(-1, { replace: true });
    }
  }, [opened, previousOpened, navigate]);

  return { opened, open, close, width: width * 1 };
};
