import { Alert } from 'antd';

interface ErrorMessageProps {
  error?: { message?: string } | null;
}

export const ErrorMessage = ({ error }: ErrorMessageProps) => {
  return <Alert message={error?.message} type="error" />;
};

export default ErrorMessage;
