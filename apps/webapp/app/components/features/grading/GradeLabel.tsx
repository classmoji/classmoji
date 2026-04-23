interface GradeLabelProps {
  children: React.ReactNode;
}

const GradeLabel = ({ children }: GradeLabelProps) => {
  return (
    <div className="text-center font-semibold p-2 bg-slate-50 w-[50px] rounded-lg">{children}</div>
  );
};

export default GradeLabel;
