import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { forwardRef } from 'react'

import { cn } from './cn'

const TooltipProvider = TooltipPrimitive.Provider
const Tooltip = TooltipPrimitive.Root
const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'pointer-events-none max-w-72 rounded-sm border border-border-default bg-surface-overlay px-2 py-1 font-ui text-small text-text-primary shadow-popup transition-[opacity,transform] data-[state=closed]:opacity-0 data-[state=delayed-open]:opacity-100 data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1 motion-reduce:transform-none motion-reduce:transition-none [z-index:var(--aw-z-tooltip)]',
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
