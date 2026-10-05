export type FeatureId = 'publish' | 'grading' | 'quiz' | 'claude';

export type Feature = {
  id: FeatureId;
  kicker: string;
  title: string;
  description: string;
  /** A docs page for the full story; shown under the description. */
  link?: { label: string; href: string };
};
