/**
 * One.Health Partners branding, recreated as SVG from the real logo files:
 *  - "full": the "one.health / PARTNERS" wordmark (navy + teal)
 *  - "mark": the four-dot icon mark (green/blue/yellow/pink), used for
 *    compact/collapsed spots and the favicon
 */
export default function Logo({ variant = 'full', className = '' }) {
  if (variant === 'mark') {
    return (
      <svg viewBox="0 0 32 32" className={className} role="img" aria-label="One.Health Partners">
        <circle cx="10" cy="10" r="7.5" fill="#3AB77D" />
        <circle cx="22" cy="10" r="7.5" fill="#1F4FA3" />
        <circle cx="10" cy="22" r="7.5" fill="#FBB816" />
        <circle cx="22" cy="22" r="7.5" fill="#EC1E79" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 176 56" className={className} role="img" aria-label="One.Health Partners">
      <text x="0" y="34" fontFamily="Inter, sans-serif" fontSize="30" fontWeight="800" fill="#1A2B3C" letterSpacing="-0.5">
        one.health
      </text>
      <text x="176" y="52" textAnchor="end" fontFamily="Inter, sans-serif" fontSize="13" fontWeight="700" fill="#0E7C7B" letterSpacing="1">
        PARTNERS
      </text>
    </svg>
  );
}
