import TweaksSection from '~/components/features/tweaks/TweaksSection';

// Personal look and feel, kept in this browser (see useDarkMode). Applies in
// every classroom, so it lives in account settings rather than a class's.
const SettingsAppearance = () => (
  <div className="w-full max-w-2xl">
    <TweaksSection />
  </div>
);

export default SettingsAppearance;
