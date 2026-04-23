import { Spin } from 'antd';
import { useNavigate } from 'react-router';
import { useEffect } from 'react';

const Loader = () => {
  const navigate = useNavigate();

  useEffect(() => {
    setTimeout(() => {
      navigate('/select-organization');
    }, 10000);
  }, []);

  return (
    <div className="w-screen h-screen flex justify-center items-center flex-col gap-8">
      <Spin size="large" />
      <h1 className="text-lg">Setting up organization on classm😊ji...</h1>
    </div>
  );
};

export default Loader;
