export interface AuthNavigation {
  redirect(url: string): void;
}

export function createBrowserAuthNavigation(location: Location = window.location): AuthNavigation {
  return {
    redirect: (url) => location.assign(url),
  };
}
