// The wheel: 10 fixed slices, drawn in SVG and turned with a CSS transform.
// The server decides the outcome; the wheel only lands on a matching slice.

export type SliceId = 'seleo' | 'mall' | 'entertainment' | 'black_kit' | 'try_again';

export const SLICES: SliceId[] = [
  'seleo', 'mall', 'black_kit', 'entertainment', 'try_again',
  'seleo', 'mall', 'black_kit', 'entertainment', 'try_again',
];

const LABELS: Record<SliceId, string[]> = {
  seleo: ['Seleo', 'Machine'],
  mall: ['Mall', 'Voucher'],
  entertainment: ['Entertainment', 'Voucher'],
  black_kit: ['Black', 'Kit'],
  try_again: ['Try', 'again'],
};

const FILL: Record<SliceId, [string, string]> = {
  seleo: ['#365888', '#ffffff'],
  mall: ['#ffffff', '#365888'],
  black_kit: ['#000000', '#ffffff'],
  entertainment: ['#ffffff', '#365888'],
  try_again: ['#e7ebef', '#5b5e61'],
};

const R = 150;
const pt = (deg: number, r: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return `${(R + r * Math.cos(a)).toFixed(2)} ${(R + r * Math.sin(a)).toFixed(2)}`;
};

export function wheelSvg(): string {
  const step = 360 / SLICES.length;
  const parts = SLICES.map((id, i) => {
    const a0 = i * step;
    const a1 = a0 + step;
    const mid = a0 + step / 2;
    const [bg, fg] = FILL[id];
    const [l1, l2] = LABELS[id];
    const size = l1.length > 9 ? 12 : 14;
    return `<path d="M${R} ${R} L${pt(a0, R - 4)} A${R - 4} ${R - 4} 0 0 1 ${pt(a1, R - 4)} Z" fill="${bg}" stroke="#909496" stroke-width="1"/>
      <g transform="rotate(${mid} ${R} ${R}) translate(${R} ${R - 84}) rotate(90)">
        <text x="0" y="-3" text-anchor="middle" fill="${fg}" font-size="${size}" font-weight="700">${l1}</text>
        <text x="0" y="${size + 1}" text-anchor="middle" fill="${fg}" font-size="${size}" font-weight="700">${l2}</text>
      </g>`;
  }).join('');
  return `<div class="wheel-wrap">
    <svg class="pointer" viewBox="0 0 40 30" aria-hidden="true"><path d="M2 2 H38 L20 28 Z" fill="#000"/></svg>
    <svg class="wheel" viewBox="0 0 ${R * 2} ${R * 2}" role="img" aria-label="Prize wheel with ten slices">
      <g class="wheel-rotor">${parts}
        <circle cx="${R}" cy="${R}" r="${R - 4}" fill="none" stroke="#365888" stroke-width="4"/>
        <circle cx="${R}" cy="${R}" r="20" fill="#ffffff" stroke="#365888" stroke-width="4"/>
      </g>
    </svg>
  </div>`;
}

// Picks one of the two matching slices, the same one every time for a session.
export function sliceFor(outcome: SliceId, sessionId: string): number {
  const matches = SLICES.map((s, i) => (s === outcome ? i : -1)).filter((i) => i >= 0);
  let h = 0;
  for (const c of sessionId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return matches[h % matches.length];
}

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let current = 0;

// Turns the wheel so that slice i stops under the pointer. Resolves when it stops.
export function spinTo(root: HTMLElement, i: number, durationMs = 5000): Promise<void> {
  const rotor = root.querySelector<SVGGElement>('.wheel-rotor');
  if (!rotor) return Promise.resolve();
  const step = 360 / SLICES.length;
  const jitter = (Math.random() - 0.5) * step * 0.6;
  const target = 360 - (i * step + step / 2) + jitter;
  const base = current - (current % 360);
  current = base + 360 * 5 + target;
  if (reduced()) {
    rotor.style.transition = 'none';
    rotor.style.transform = `rotate(${current}deg)`;
    return Promise.resolve();
  }
  rotor.style.transition = `transform ${durationMs}ms cubic-bezier(0.12, 0.6, 0.12, 1)`;
  rotor.style.transform = `rotate(${current}deg)`;
  return new Promise((resolve) => setTimeout(resolve, durationMs + 100));
}

// Shows a slice under the pointer without animation (used when resuming).
export function showSlice(root: HTMLElement, i: number) {
  const rotor = root.querySelector<SVGGElement>('.wheel-rotor');
  if (!rotor) return;
  const step = 360 / SLICES.length;
  current = 360 - (i * step + step / 2);
  rotor.style.transition = 'none';
  rotor.style.transform = `rotate(${current}deg)`;
}
