import { useEffect, useState } from 'react';

/**
 * Loads one bearer-authenticated attachment exactly once and hands the caller a revocable object
 * URL. `load` must be stable for one key (wrap it in `useCallback`): the effect treats a new loader
 * identity as a new object to fetch.
 */
export function useAttachmentObjectUrl(
  key: string,
  load: () => Promise<Blob>,
): { readonly url?: string; readonly failed: boolean } {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    void load().then(
      (blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [key, load]);

  return { ...(url ? { url } : {}), failed };
}
