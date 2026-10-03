import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type ButtonHTMLAttributes } from 'react'

import { cn } from './cn'

const buttonVariants = cva(
  'inline-flex min-w-0 items-center justify-center gap-1.5 rounded-sm border border-transparent font-ui text-ui font-medium whitespace-nowrap transition-colors select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-canvas disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-text-on-accent hover:bg-accent-hover active:bg-accent-hover',
        secondary:
          'border-border-default bg-surface-interactive text-text-primary hover:bg-surface-interactive-hover active:bg-surface-interactive-active',
        ghost:
          'bg-transparent text-text-secondary hover:bg-surface-interactive-hover hover:text-text-primary active:bg-surface-interactive-active',
        destructive:
          'bg-destructive text-text-on-accent hover:bg-destructive-hover active:bg-destructive-hover'
      },
      size: {
        small: 'h-7 px-2.5',
        default: 'h-8 px-3',
        large: 'h-9 px-4',
        icon: 'size-8 p-0'
      }
    },
    defaultVariants: {
      size: 'default',
      variant: 'secondary'
    }
  }
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ asChild = false, className, size, type, variant, ...props }, ref) => {
    const Component = asChild ? Slot : 'button'

    return (
      <Component
        ref={ref}
        className={cn(buttonVariants({ className, size, variant }))}
        type={asChild ? undefined : (type ?? 'button')}
        {...props}
      />
    )
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
