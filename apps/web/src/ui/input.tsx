import { forwardRef, type InputHTMLAttributes } from 'react'

import { cn } from './cn'

export type InputProps = InputHTMLAttributes<HTMLInputElement>

const Input = forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      'h-8 w-full min-w-0 rounded-sm border border-border-default bg-surface-canvas px-2.5 font-ui text-ui text-text-primary shadow-none transition-colors placeholder:text-text-muted hover:border-border-strong focus-visible:border-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/35 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/30 motion-reduce:transition-none',
      className
    )}
    {...props}
  />
))
Input.displayName = 'Input'

export { Input }
