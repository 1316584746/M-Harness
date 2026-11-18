/** 应用图标：深色圆底 + 三条电子轨道的原子。与 build/icon.png 是同一个图形 */
export function Logo({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-label="M-Harness" role="img">
      <circle cx="12" cy="12" r="12" fill="#2b2e3a" />
      <g fill="none" stroke="#86b9bf" strokeWidth="0.8" strokeLinecap="round">
        <ellipse cx="12" cy="12" rx="7.6" ry="3" transform="rotate(30 12 12)" />
        <ellipse cx="12" cy="12" rx="7.6" ry="3" transform="rotate(90 12 12)" />
        <ellipse cx="12" cy="12" rx="7.6" ry="3" transform="rotate(150 12 12)" />
      </g>
      <circle cx="12" cy="12" r="1.1" fill="#86b9bf" />
    </svg>
  );
}
