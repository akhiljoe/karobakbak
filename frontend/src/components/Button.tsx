import { type ButtonHTMLAttributes, forwardRef } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variants: Record<Variant, string> = {
  primary:
    'bg-amber-400 text-ink-950 hover:bg-amber-300 active:bg-amber-500 shadow-soft disabled:bg-ink-700 disabled:text-ink-400',
  secondary: 'bg-ink-800 text-ink-100 hover:bg-ink-700 border border-ink-700 disabled:opacity-50',
  ghost: 'bg-transparent text-ink-200 hover:bg-ink-800 hover:text-ink-50 disabled:opacity-40',
  danger:
    'bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 border border-rose-500/30 disabled:opacity-50',
};

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3.5 text-sm gap-1.5 rounded-lg',
  md: 'h-11 px-5 text-base gap-2 rounded-xl',
  lg: 'h-14 px-7 text-lg gap-2.5 rounded-xl',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className = '', ...props }, ref) => (
    <button
      ref={ref}
      className={`inline-flex items-center justify-center font-semibold transition-all duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:active:scale-100 ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
