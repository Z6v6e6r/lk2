import { useEffect } from 'react';

import styles from './ChatsUi.module.css';

/**
 * Full-screen preview for one chat picture. The bubble already holds the authorized object URL, so
 * the viewer only has to enlarge it: Escape, the backdrop and the close control all dismiss it, and
 * the dialog label repeats the image alt text so a screen reader announces the same file.
 */
export function ChatImageViewer({
  src,
  alt,
  onClose,
}: {
  readonly src: string;
  readonly alt: string;
  readonly onClose: () => void;
}): React.JSX.Element {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className={styles.imageViewer} role="dialog" aria-modal="true" aria-label={alt}>
      <button
        type="button"
        className={styles.imageViewerBackdrop}
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
      />
      <img className={styles.imageViewerImage} src={src} alt={alt} />
      <button
        type="button"
        className={styles.imageViewerClose}
        aria-label="Закрыть изображение"
        onClick={onClose}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
