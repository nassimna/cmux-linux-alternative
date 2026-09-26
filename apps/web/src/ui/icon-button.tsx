import { forwardRef } from 'react'

import { Button, type ButtonProps } from './button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'

export interface IconButtonProps extends Omit<ButtonProps, 'aria-label' | 'size'> {
  'aria-label': string
  size?: Extract<ButtonProps['size'], 'small' | 'default' | 'large' | 'icon'>
  tooltip?: string
}

const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ 'aria-label': ariaLabel, size = 'icon', tooltip, ...props }, ref) => {
    const button = <Button ref={ref} aria-label={ariaLabel} size={size} {...props} />

    if (!tooltip) {
      return button
    }

    return (
      <TooltipProvider delayDuration={400}>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }
)
IconButton.displayName = 'IconButton'

export { IconButton }
