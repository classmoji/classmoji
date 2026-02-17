import { Result, Button } from 'antd';
import { IconAlertTriangle } from '@tabler/icons-react';
import { ErrorBoundary as ReactErrorBoundary } from 'react-error-boundary';
function ErrorFallback({ error, resetErrorBoundary }) {
  const isDevelopment = import.meta.env.MODE === 'development';

  const handleReset = () => {
    resetErrorBoundary();
  };

  const handleReload = () => {
    window.location.reload();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
      <Result
        icon={<IconAlertTriangle size={72} className="text-red-500" />}
        status="error"
        title="Something went wrong"
        subTitle={
          isDevelopment
            ? error?.message
            : "We're sorry, but something unexpected happened. Please try refreshing the page or contact support if the problem persists."
        }
        extra={[
          <Button key="retry" type="primary" onClick={handleReset}>
            Try Again
          </Button>,
          <Button key="reload" onClick={handleReload}>
            Refresh Page
          </Button>,
        ]}
      >
        {isDevelopment && error && (
          <div className="mt-6 text-left">
            <details className="cursor-pointer">
              <summary className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Error Details (Development Only)
              </summary>
              <pre className="mt-2 p-4 bg-gray-100 dark:bg-gray-800 rounded-md text-xs overflow-auto max-h-96">
                <code className="text-red-600 dark:text-red-400">{error?.stack}</code>
              </pre>
            </details>
          </div>
        )}
      </Result>
    </div>
  );
}

export default function ErrorBoundary({ children }) {
  return (
    <ReactErrorBoundary
      FallbackComponent={ErrorFallback}
      onError={(error, errorInfo) => {
        if (import.meta.env.MODE === 'development') {
          console.error('Error caught by boundary:', error, errorInfo);
        }
      }}
      onReset={() => {
        // Optional: Clear any error state in your app
        window.location.hash = '';
      }}
    >
      {children}
    </ReactErrorBoundary>
  );
}
