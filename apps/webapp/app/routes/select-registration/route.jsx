import { Button } from 'antd';
import { Link } from 'react-router';
import { Logo } from '@classmoji/ui-components';

const SelectRegistration = () => {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
      <div className="flex justify-center mb-4">
        <Logo size={48} />
      </div>{' '}
      <h1 className="text-2xl font-bold mb-2">Let us create your account!</h1>
      <div className="flex gap-8 mt-8">
        <Link to="/connect-account">
          <Button>Student</Button>
        </Link>
        <Button
          onClick={() => {
            window.location.href = 'https://forms.dali.dartmouth.edu/t/cRa51QiJ3hus';
          }}
        >
          Instructor
        </Button>
      </div>
    </div>
  );
};

export default SelectRegistration;
