export const getUsageData = ({
  isFreeTier,
  isProTier,
}: {
  isFreeTier: boolean;
  isProTier: boolean;
}): Array<{
  key: string;
  feature: string;
  allowed: number | boolean;
  used: number | boolean | null;
  available: boolean;
}> => [
  {
    key: 'students',
    feature: 'Students per course',
    allowed: isFreeTier ? 15 : 100,
    used: 15,
    available: true,
  },
  {
    key: 'courses',
    feature: 'Active courses',
    allowed: isFreeTier ? 1 : 3,
    used: 1,
    available: true,
  },
  {
    key: 'github',
    feature: 'GitHub integration',
    allowed: true,
    used: true,
    available: true,
  },
  {
    key: 'emoji',
    feature: 'Emoji grading',
    allowed: true,
    used: true,
    available: true,
  },
  {
    key: 'ta',
    feature: 'TA management',
    allowed: isProTier,
    used: isProTier ? true : null,
    available: isProTier,
  },
  {
    key: 'team',
    feature: 'Team projects',
    allowed: isProTier,
    used: isProTier ? true : null,
    available: isProTier,
  },
  {
    key: 'tokens',
    feature: 'Tokens use for extensions',
    allowed: isProTier,
    used: isProTier ? true : null,
    available: true,
  },
  {
    key: 'support',
    feature: 'Priority support',
    allowed: isProTier,
    used: isProTier ? true : null,
    available: isProTier,
  },
];
