// VEXIE, the Vaktex mascot, as inline SVG for the webviews. No vscode import.
//
// The same figure as vaktex.com (marketing_site src/lib/components/ui/
// VexieAvatar.svelte): a gradient body with two ears and a gloss. This is the
// happy pose for a clean scan: the same face, its eyes closed in a smile.
// Colours are --vexie-* tokens (src/theme.ts) set through classes,
// because the webview CSP drops style="" attributes.

export function happyVexie(size = 72): string {
  return `<svg class="vx" width="${size}" height="${size}" viewBox="0 0 100 100" role="img" aria-label="VEXIE, smiling">
  <defs>
    <radialGradient id="vx-sky" cx="0.36" cy="0.3" r="0.78"><stop class="vx-s0" offset="0"/><stop class="vx-s1" offset="0.5"/><stop class="vx-s2" offset="1"/></radialGradient>
    <radialGradient id="vx-gloss" cx="0.32" cy="0.26" r="0.32"><stop class="vx-g" offset="0" stop-opacity=".55"/><stop class="vx-g" offset="1" stop-opacity="0"/></radialGradient>
  </defs>
  <g class="vx-fig">
    <g fill="url(#vx-sky)">
      <path class="vx-ear-l" d="M 22 46 C 17 33 20 20 30 15 C 39 15 44 27 42 39 Z"/>
      <path class="vx-ear-r" d="M 78 46 C 83 33 80 20 70 15 C 61 15 56 27 58 39 Z"/>
      <ellipse cx="50" cy="61" rx="35" ry="31"/>
    </g>
    <ellipse cx="50" cy="61" rx="35" ry="31" fill="url(#vx-gloss)"/>
    <g class="vx-face" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path d="M 35.5 62 Q 41 54.5 46.5 62" stroke-width="3.4"/>
      <path d="M 53.5 62 Q 59 54.5 64.5 62" stroke-width="3.4"/>
    </g>
  </g>
</svg>`;
}

export const VEXIE_CSS = `
.vx { display: block; overflow: visible; }
.vx-s0 { stop-color: var(--vexie-light); }
.vx-s1 { stop-color: var(--vexie); }
.vx-s2 { stop-color: var(--vexie-deep); }
.vx-g { stop-color: #fff; }
.vx-face { stroke: var(--vexie-eye); }
.vx-fig, .vx-ear-l, .vx-ear-r { transform-box: fill-box; }
.vx-fig { transform-origin: 50% 100%; animation: vx-hop 0.9s cubic-bezier(0.45, 0, 0.55, 1) 0.15s both, vx-bob 3.2s ease-in-out 1.2s infinite; }
.vx-ear-l { transform-origin: 70% 100%; animation: vx-ear-l 3.2s ease-in-out 1.2s infinite; }
.vx-ear-r { transform-origin: 30% 100%; animation: vx-ear-r 3.2s ease-in-out 1.2s infinite; }
@keyframes vx-hop {
  0% { transform: none; }
  25% { transform: translateY(2px) scale(1.06, 0.94); }
  55% { transform: translateY(-10px) scale(0.95, 1.06); }
  80% { transform: translateY(0) scale(1.05, 0.95); }
  100% { transform: none; }
}
@keyframes vx-bob { 0%, 100% { transform: none; } 50% { transform: translateY(-2px); } }
@keyframes vx-ear-l { 0%, 70%, 100% { transform: none; } 78% { transform: rotate(-10deg); } 86% { transform: rotate(4deg); } }
@keyframes vx-ear-r { 0%, 72%, 100% { transform: none; } 80% { transform: rotate(10deg); } 88% { transform: rotate(-4deg); } }
@media (prefers-reduced-motion: reduce) { .vx-fig, .vx-ear-l, .vx-ear-r { animation: none; } }
`;
