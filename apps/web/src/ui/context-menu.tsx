import * as ContextMenuPrimitive from '@radix-ui/react-context-menu'
import { ChevronRight } from 'lucide-react'
import { forwardRef } from 'react'

import { cn } from './cn'

const ContextMenu = ContextMenuPrimitive.Root
const ContextMenuTrigger = ContextMenuPrimitive.Trigger
const ContextMenuSub = ContextMenuPrimitive.Sub

const menuContentClasses =
  'min-w-44 overflow-hidden rounded-md border border-border-default bg-surface-overlay p-1 text-text-primary shadow-popup transition-[opacity,transform] data-[state=closed]:opacity-0 data-[state=open]:opacity-100 motion-reduce:transform-none motion-reduce:transition-none [z-index:var(--aw-z-dropdown)]'

const ContextMenuContent = forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, collisionPadding = 8, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      ref={ref}
      className={cn(menuContentClasses, className)}
      collisionPadding={collisionPadding}
      loop
      {...props}
    />
  </ContextMenuPrimitive.Portal>
))
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName

const ContextMenuItem = forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex min-h-7 cursor-default items-center gap-2 rounded-sm px-2 py-1 font-ui text-ui outline-none select-none focus:bg-surface-interactive-hover focus:text-text-primary data-[highlighted]:bg-surface-interactive-hover data-[highlighted]:text-text-primary data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      destructive &&
        'text-destructive focus:bg-destructive/15 focus:text-destructive data-[highlighted]:bg-destructive/15 data-[highlighted]:text-destructive',
      className
    )}
    {...props}
  />
))
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName

const ContextMenuSeparator = forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn('-mx-1 my-1 h-px bg-border-default', className)}
    {...props}
  />
))
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName

const ContextMenuSubTrigger = forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger>
>(({ children, className, ...props }, ref) => (
  <ContextMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      'flex min-h-7 cursor-default items-center gap-2 rounded-sm px-2 py-1 font-ui text-ui outline-none select-none focus:bg-surface-interactive-hover focus:text-text-primary data-[highlighted]:bg-surface-interactive-hover data-[state=open]:bg-surface-interactive-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      className
    )}
    {...props}
  >
    {children}
    <ChevronRight aria-hidden="true" className="ml-auto size-3.5" />
  </ContextMenuPrimitive.SubTrigger>
))
ContextMenuSubTrigger.displayName = ContextMenuPrimitive.SubTrigger.displayName

const ContextMenuSubContent = forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(({ className, collisionPadding = 8, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.SubContent
      ref={ref}
      className={cn(menuContentClasses, className)}
      collisionPadding={collisionPadding}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
))
ContextMenuSubContent.displayName = ContextMenuPrimitive.SubContent.displayName

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
}
