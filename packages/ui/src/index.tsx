import type { ButtonHTMLAttributes, PropsWithChildren } from 'react';

export const designTokens = {
  color: {
    background: '#f4f7f2',
    surface: '#ffffff',
    text: '#172019',
    muted: '#627067',
    accent: '#49a85a',
    accentStrong: '#2f7d3f',
  },
  radius: { small: '10px', medium: '18px', large: '28px' },
} as const;

export function PrimaryButton({
  children,
  style,
  ...props
}: PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>): React.JSX.Element {
  return (
    <button
      {...props}
      style={{
        appearance: 'none',
        border: 0,
        borderRadius: designTokens.radius.medium,
        background: designTokens.color.accent,
        color: '#fff',
        cursor: 'pointer',
        font: 'inherit',
        fontWeight: 700,
        padding: '12px 18px',
        ...style,
      }}
    >
      {children}
    </button>
  );
}
