import { code128, isCode128B } from "./code128";

/**
 * A Code 128 barcode as SVG bars (no library, no image). Always drawn ink-on-paper in a light island, so it scans
 * from a screen in dark mode and prints black on white. `height` is in modules (a module ≈ the narrowest bar).
 */
export function Barcode({ value, label, height = 48, className }: { value: string; label: string; height?: number; className?: string }) {
  if (!isCode128B(value)) return null;
  const symbol = code128(value);
  return (
    <svg
      viewBox={`0 0 ${symbol.modules} ${height}`}
      role="img"
      aria-label={label}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      className={className}
      width="100%"
      height="100%"
    >
      {symbol.bars.map(([x, width]) => (
        <rect key={x} x={x} y={0} width={width} height={height} fill="currentColor" />
      ))}
    </svg>
  );
}
