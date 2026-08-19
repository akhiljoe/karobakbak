/**
 * The identity mark for one side of a conversation.
 *
 * Both the glyph and the colour come from the server-generated `Identity` that
 * arrived on the `matched` frame. Nothing here derives an appearance from a
 * session id: anything stable across matches would be a correlation handle
 * (`DESIGN.md` §24.3).
 */
interface AvatarProps {
  glyph: string;
  colour: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  pulsing?: boolean;
  className?: string;
}

const sizeMap = {
  sm: 'h-9 w-9 text-sm',
  md: 'h-12 w-12 text-base',
  lg: 'h-16 w-16 text-xl',
  xl: 'h-24 w-24 text-3xl',
};

export function Avatar({
  glyph,
  colour,
  size = 'md',
  pulsing = false,
  className = '',
}: AvatarProps): JSX.Element {
  return (
    <span className={`relative inline-flex ${className}`} aria-hidden="true">
      {pulsing && (
        <>
          <span
            className="absolute inset-0 rounded-full animate-pulse-ring"
            style={{ background: colour, opacity: 0.4 }}
          />
          <span
            className="absolute inset-0 rounded-full animate-pulse-ring"
            style={{ background: colour, opacity: 0.3, animationDelay: '1s' }}
          />
        </>
      )}
      <span
        className={`relative inline-flex items-center justify-center rounded-full font-display font-semibold ring-2 ring-ink-950/40 ${sizeMap[size]}`}
        style={{
          background: `radial-gradient(120% 120% at 30% 25%, ${colour}, ${colour}cc 60%, ${colour}88)`,
          color: '#1c1812',
          boxShadow: `0 4px 18px ${colour}40`,
        }}
      >
        {glyph}
      </span>
    </span>
  );
}
