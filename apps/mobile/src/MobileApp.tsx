import type { MobileAuthAppProps } from './MobileAuthApp.js';
import { MobileAuthApp } from './MobileAuthApp.js';
import { AuthErrorBoundary } from './AuthErrorBoundary.js';

export function MobileApp(props: MobileAuthAppProps): React.JSX.Element {
  return (
    <AuthErrorBoundary>
      <MobileAuthApp {...props} />
    </AuthErrorBoundary>
  );
}
