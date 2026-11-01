/** The Strawvine mark: a rising vine — three ascending strokes. */
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-hidden>
      <defs>
        <linearGradient id="sv-g" x1="4" y1="28" x2="28" y2="4" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6ee7d8" />
          <stop offset="1" stopColor="#b7f36a" />
        </linearGradient>
      </defs>
      <path d="M6 26 C 10 20, 12 16, 11 9" stroke="url(#sv-g)" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M13 26 C 17 20, 19 15, 18 6" stroke="url(#sv-g)" strokeWidth="2.6" strokeLinecap="round" opacity="0.85" />
      <path d="M20 26 C 24 21, 26 17, 26 12" stroke="url(#sv-g)" strokeWidth="2.6" strokeLinecap="round" opacity="0.7" />
    </svg>
  );
}
