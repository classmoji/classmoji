import useStore from '~/store';
import { useUser } from './useUser';

export const useSubscription = (mode = 'org') => {
  const { subscription: orgSubscription } = useStore();
  const { user } = useUser();
  const subscription = mode === 'org' ? orgSubscription : user?.subscription;

  // Handle null/undefined subscription (before API loads or no subscription exists)
  if (!subscription) {
    return {
      tier: 'FREE',
      isFreeTier: true,
      isProTier: false,
      isActive: true,
      canAddTAs: true,
      canManageTeams: true,
    };
  }

  const isFreeTier = subscription.tier === 'FREE';
  const isProTier = subscription.tier === 'PRO';

  // Compute status from ends_at date (status field was removed from schema)
  const isActive = subscription.ends_at ? new Date(subscription.ends_at) > new Date() : true;

  return {
    tier: subscription.tier,
    isFreeTier,
    isProTier,
    isActive,
    canAddTAs: true,
    canManageTeams: true,
  };
};
