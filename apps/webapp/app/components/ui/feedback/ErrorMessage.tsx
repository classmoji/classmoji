import { Alert } from 'antd';

interface ErrorMessageProps {
  error?: { message?: string } | null;
}

export const ErrorMessage = ({ error }: ErrorMessageProps) => {
  return <Alert title={error?.message} type="error" />;
};

export default ErrorMessage;
