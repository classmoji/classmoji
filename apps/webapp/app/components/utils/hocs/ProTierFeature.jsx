import { useSubscription } from '~/hooks';
import useStore from '~/store';
import { DEMO_ORG_ID } from '~/constants';

const ProTierFeature = ({ children }) => {
  const { isProTier } = useSubscription();
  const { classroom } = useStore();

  const isDemoClassroom = Number(classroom?.id) === DEMO_ORG_ID;

  if (!isProTier && isDemoClassroom === false) return null;

  return children;
};

export default ProTierFeature;
