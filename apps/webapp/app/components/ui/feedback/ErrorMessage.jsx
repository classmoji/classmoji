import { Alert } from 'antd';

export const ErrorMessage = ({ error }) => {
  return <Alert message={error?.message} type="error" />;
};

export default ErrorMessage;
