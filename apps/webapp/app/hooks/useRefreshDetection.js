import { useEffect, useState } from 'react';

export const useRefreshDetection = () => {
  const [isRefresh, setIsRefresh] = useState(false);

  useEffect(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    setIsRefresh(navigation?.type === 'reload');
  }, []);

  return isRefresh;
};
