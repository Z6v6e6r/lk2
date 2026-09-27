import { Fragment, useMemo } from 'react';

import { splitChatLinks } from './chat-links.js';

interface LinkedMessageTextProps {
  readonly text: string;
  /** Each chat surface has its own palette, so the host passes the link class from its CSS module. */
  readonly linkClassName?: string | undefined;
}

/**
 * Renders one message body with its links clickable. Text stays text: every segment is a React child,
 * so a message can never inject markup, and the parser only emits http(s) destinations.
 */
export function LinkedMessageText({
  text,
  linkClassName,
}: LinkedMessageTextProps): React.JSX.Element {
  const segments = useMemo(() => splitChatLinks(text), [text]);
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'link' ? (
          <a
            key={index}
            className={linkClassName}
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {segment.value}
          </a>
        ) : (
          <Fragment key={index}>{segment.value}</Fragment>
        ),
      )}
    </>
  );
}
