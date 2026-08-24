import { Component } from 'react';
import type { ReactNode } from 'react';

interface AuthErrorBoundaryProps {
  readonly children: ReactNode;
}

interface AuthErrorBoundaryState {
  readonly failed: boolean;
}

export class AuthErrorBoundary extends Component<AuthErrorBoundaryProps, AuthErrorBoundaryState> {
  public override state: AuthErrorBoundaryState = { failed: false };

  public static getDerivedStateFromError(): AuthErrorBoundaryState {
    return { failed: true };
  }

  public override componentDidCatch(): void {
    // Deliberately avoid logging auth state or API responses from the render tree.
  }

  public override render(): ReactNode {
    if (this.state.failed) {
      return (
        <main className="auth-fallback" aria-labelledby="auth-fallback-title">
          <h1 id="auth-fallback-title">Не удалось открыть экран входа</h1>
          <p>Попробуйте запустить вход заново.</p>
          <button type="button" onClick={() => this.setState({ failed: false })}>
            Начать вход заново
          </button>
        </main>
      );
    }

    return this.props.children;
  }
}
