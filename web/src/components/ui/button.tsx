import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors ' +
    'disabled:pointer-events-none disabled:opacity-50 ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:opacity-90',
        // `.btn.ghost` in layout-preview.html — the stronger glass tier
        // (same as the header/controls chrome). Hover uses a translucent
        // tint (not solid bg-muted) so the backdrop-blur stays visible.
        outline: 'glass-chrome border text-foreground hover:bg-muted/40',
        ghost: 'text-foreground hover:bg-muted',
        // Bug fix (user-reported): "the active tab ... with just white it
        // is hard to see" — `outline`'s translucent glass tint barely reads
        // against the sidebar's own glass background. A clearly-tinted,
        // theme-aware accent fill (the `--accent`/`--accent-foreground`
        // pair, already reserved for exactly this) for "this nav entry is
        // the current view" — distinct from `default`'s solid CTA look.
        // Follow-up (user-reported): the full-strength fill read as "too
        // aggressive" — toned down to a softer tint at reduced opacity,
        // same font weight as every other button (no extra `font-semibold`).
        accent: 'bg-accent/50 text-accent-foreground hover:bg-accent/65',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = 'Button';
