import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonTone = 'default' | 'accent' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
  size?: ButtonSize;
  children: ReactNode;
}

const TONE: Record<ButtonTone, string> = {
  default: 'bg-ink-700 hover:bg-ink-600 text-ink-100 border border-ink-600',
  accent: 'bg-accent-700 hover:bg-accent-600 text-ink-900 font-medium border border-accent-700',
  danger: 'bg-ink-700 hover:bg-error-500/20 text-error-500 border border-error-500/30',
  ghost: 'bg-transparent hover:bg-ink-700/60 text-ink-200 border border-transparent',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'px-2 py-1 text-xs',
  md: 'px-3 py-1.5 text-sm',
};

export function Button({
  tone = 'default',
  size = 'md',
  className = '',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={`rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 disabled:opacity-50 disabled:cursor-not-allowed ${TONE[tone]} ${SIZE[size]} ${className}`}
    >
      {children}
    </button>
  );
}
