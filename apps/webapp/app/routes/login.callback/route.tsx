/**
 * GitHub App Installation Callback
 *
 * This route handles the redirect from GitHub after a user installs the GitHub App.
 * GitHub redirects here with installation_id and setup_action params.
 *
 * If opened in a popup (from our create-classroom flow), it closes the popup.
 * If opened directly, it redirects to the create-classroom page.
 */

export const loader = async () => {
  // Return empty data - the client-side script handles everything
  return {};
};

const LoginCallback = () => {
  return (
    <html>
      <head>
        <title>Installation Complete</title>
      </head>
      <body>
        <div style={{ fontFamily: 'system-ui', padding: '40px', textAlign: 'center' }}>
          <h2>GitHub App Installed Successfully!</h2>
          <p>Closing this window...</p>
        </div>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              // If this is a popup, close it - the parent window will detect the close
              if (window.opener) {
                window.close();
              } else {
                // If not a popup (user navigated directly), redirect to create-classroom
                window.location.href = '/create-classroom';
              }
            `,
          }}
        />
      </body>
    </html>
  );
};

export default LoginCallback;
