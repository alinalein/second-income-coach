import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  {
    variants: {
      variant: {
        // Accent badge — teal tokens, the one surface this accent is allowed on.
        default: 'border-transparent bg-accent text-accent-foreground',
        // User instruction (round 3) explicitly puts badges among the
        // glass/blur surfaces, so `muted`/`outline` use `glass-chrome` +
        // --shadow like the other chrome controls, even though
        // layout-preview.html's own `.badge.neutral` has no backdrop-filter
        // — an explicit instruction for this element overrides the literal
        // reference file here. Text is --foreground, not --muted-foreground:
        // with a soft accent blob behind the glass, --muted-foreground can
        // measure as low as ~3:1 (confirmed by direct computation across
        // every surface/page/blob combination); --foreground stays safe
        // (≥6.4:1 worst case, every combination).
        muted: 'border-transparent glass-chrome shadow-[var(--shadow)] text-foreground',
        outline: 'glass-chrome border shadow-[var(--shadow)] text-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
