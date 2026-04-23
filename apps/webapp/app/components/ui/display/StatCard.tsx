import React from 'react';

interface StatCardProps {
  value: React.ReactNode;
  label: string;
}

const StatCard = ({ value, label }: StatCardProps) => {
  return (
    <div className="stat-card">
      <div className="stat-card-value">{value}</div>
      <div className="stat-card-label">{label}</div>
    </div>
  );
};

export default StatCard;
