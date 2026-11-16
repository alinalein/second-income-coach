import * as React from 'react';
import { cn } from '../../lib/utils';

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

/**
 * A plain native `<select>`, styled to match `Input`/`Textarea` (Code Map:
 * "none exist; no form lib ... hand-write") — no Radix/combobox dependency,
 * since the form's enum fields (weekly time, budget, risk tolerance) are
 * small, fixed option sets a native select handles fine.
 */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      'h-10 w-full rounded-md border border-border bg-card px-3 text-sm text-foreground ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
        'disabled:pointer-events-none disabled:opacity-50',
      className,
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = 'Select';
