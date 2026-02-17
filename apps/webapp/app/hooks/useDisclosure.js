import { useState } from 'react';

export const useDisclosure = () => {
  const [visible, setVisible] = useState(false);
  const show = () => setVisible(true);
  const close = () => setVisible(false);
  return { show, close, visible };
};
