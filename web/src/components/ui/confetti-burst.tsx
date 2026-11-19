import * as React from 'react';

/**
 * User-reported, live: "when the user finishes the plan, I want a little
 * confetti animation that overlays the middle of the screen — the text
 * from the AI alone isn't enough." A small, dependency-free burst (no new
 * package — plain `<span>`s animated via CSS custom properties, same
 * category as this app's own hand-rolled page-level blobs in `index.css`)
 * centered on the viewport, fired once and self-cleaning via `onDone`.
 * Respects `prefers-reduced-motion` the same way `MyPlansList`'s own
 * `motion-reduce:transition-none` does elsewhere in this app — skips the
 * animation (and calls `onDone` immediately) rather than forcing motion on
 * a viewer who's asked not to have it.
 *
 * User-reported follow-up: "a bit cheap" — scaled up across the board
 * (more pieces, larger size, much further travel distance), not just one
 * number tweaked in isolation; `TOTAL_DURATION_MS` raised to match the
 * longer travel time so nothing gets cut off mid-flight.
 */
const PIECE_COUNT = 110;
const COLORS = ['#14b8a6', '#f59e0b', '#ec4899', '#3b82f6', '#a855f7', '#eab308', '#ef4444'];
const TOTAL_DURATION_MS = 3000;

interface ConfettiPieceStyle extends React.CSSProperties {
  '--dx': string;
  '--dy': string;
  '--rotate': string;
  '--duration': string;
  '--delay': string;
}

interface ConfettiPiece {
  id: number;
  style: ConfettiPieceStyle;
  color: string;
  width: number;
  height: number;
}

function generatePieces(count: number): ConfettiPiece[] {
  return Array.from({ length: count }, (_, id) => {
    const angle = Math.random() * Math.PI * 2;
    const distance = 280 + Math.random() * 460;
    const dx = Math.cos(angle) * distance;
    // Biased downward — confetti falls under gravity, it doesn't float evenly in every direction.
    const dy = Math.sin(angle) * distance * 0.5 + 260;
    return {
      id,
      color: COLORS[id % COLORS.length]!,
      width: 10 + Math.random() * 10,
      height: 7 + Math.random() * 7,
      style: {
        '--dx': `${dx}px`,
        '--dy': `${dy}px`,
        '--rotate': `${Math.random() * 1080 - 540}deg`,
        '--duration': `${1.8 + Math.random() * 1.0}s`,
        '--delay': `${Math.random() * 0.25}s`,
      },
    };
  });
}

export function ConfettiBurst({ onDone }: { onDone: () => void }) {
  const [pieces] = React.useState(() => generatePieces(PIECE_COUNT));
  const [reducedMotion] = React.useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  React.useEffect(() => {
    const timer = window.setTimeout(onDone, reducedMotion ? 0 : TOTAL_DURATION_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (reducedMotion) return null;

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[100] overflow-hidden">
      {pieces.map((piece) => (
        <span
          key={piece.id}
          className="absolute left-1/2 top-1/2 rounded-sm opacity-0 [animation:confetti-fall_var(--duration)_ease-out_var(--delay)_forwards]"
          style={{ ...piece.style, width: piece.width, height: piece.height, backgroundColor: piece.color }}
        />
      ))}
    </div>
  );
}
