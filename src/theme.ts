// Shared look for vakt's webviews (finding panel, findings list). No vscode
// import, so it is unit-testable.

/** Vaktex Sans (media/fonts, OFL), the vaktex.com face. Latin cut only; other scripts fall back. */
export function fontFace(uri: string): string {
  return `@font-face{font-family:"Vaktex Sans";src:url("${uri}") format("woff2");font-weight:100 900;font-display:swap;}`;
}

// Colours are vaktex.com's tokens (marketing_site src/routes/layout.css,
// named in the comments). The site has no dark theme, so dark mode is built
// from its sand scale with the same accents. VS Code puts vscode-light /
// vscode-dark / vscode-high-contrast on <body>; high contrast keeps the
// theme's own colours.
export const THEME_CSS = `
:root {
  --bg: #fbfaf6;            /* paper */
  --panel: #f5f3ee;         /* sand-50 */
  --panel2: #ecebe7;        /* sand-150 */
  --ink: #141413;           /* ink */
  --muted: #5f5e59;         /* sand-650 */
  --line: #e8e5de;          /* sand-200 */
  --track: #f0eee8;         /* sand-100 */
  --bar: #3b7be8;           /* blue */
  --bar-dim: #b5b2aa;       /* sand-400 */
  --tick: var(--bar);       /* top family's cut-off matches its bar */
  --crit-bg: #ffd9ca; --crit: #b83a17;   /* peach / rust */
  --high-bg: #ffc7b2; --high: #b83a17;   /* peach-deep / rust */
  --med-bg: #ffdc79; --med: #141413;     /* butter / ink */
  --low-bg: #ecebe7; --low: #45433f;     /* sand-150 / sand-800 */
  --blue-bg: #b5daf5; --blue: #1f4e7a;   /* sky / navy */
  --primary: #141413; --on-primary: #fbfaf6;
  --code: #fff;
  --focus: #3b7be8;
  --sans: "Vaktex Sans", var(--vscode-font-family, -apple-system, system-ui, sans-serif);
  --mono: var(--vscode-editor-font-family, ui-monospace, Menlo, monospace);
}
body.vscode-dark {
  --bg: #1e1d1b;            /* sand-975 */
  --panel: #22211f;         /* sand-950 */
  --panel2: #2c2b28;        /* sand-925 */
  --ink: #fbfaf6;           /* paper */
  --muted: #b5b2aa;         /* sand-400 */
  --line: #33322f;          /* sand-900 */
  --track: #2c2b28;         /* sand-925 */
  --bar: #b5daf5;           /* sky */
  --bar-dim: #55544f;       /* sand-700 */
  --tick: var(--bar);
  --crit-bg: #b83a17; --crit: #ffd9ca;   /* rust / peach */
  --high-bg: #b83a17; --high: #ffd9ca;
  --med-bg: #ffdc79; --med: #141413;     /* butter / ink */
  --low-bg: #2c2b28; --low: #cfccc4;     /* sand-925 / sand-300 */
  --blue-bg: #1f4e7a; --blue: #b5daf5;   /* navy / sky */
  --primary: #fbfaf6; --on-primary: #141413;
  --code: #141413;          /* ink */
  --focus: #b5daf5;
}
body.vscode-high-contrast, body.vscode-high-contrast-light {
  --bg: var(--vscode-editor-background); --panel: var(--vscode-editor-background); --panel2: var(--vscode-editor-background);
  --ink: var(--vscode-foreground); --muted: var(--vscode-foreground); --line: var(--vscode-contrastBorder);
  --track: var(--vscode-editor-background); --bar: var(--vscode-foreground); --bar-dim: var(--vscode-descriptionForeground); --tick: var(--vscode-contrastActiveBorder);
  --crit-bg: transparent; --crit: var(--vscode-foreground); --high-bg: transparent; --high: var(--vscode-foreground);
  --med-bg: transparent; --med: var(--vscode-foreground); --low-bg: transparent; --low: var(--vscode-foreground);
  --blue-bg: transparent; --blue: var(--vscode-textLink-foreground);
  --primary: var(--vscode-button-background); --on-primary: var(--vscode-button-foreground); --code: var(--vscode-editor-background);
  --focus: var(--vscode-focusBorder);
}
body.vscode-high-contrast .tag, body.vscode-high-contrast-light .tag, body.vscode-high-contrast .bar, body.vscode-high-contrast-light .bar { outline: 1px solid var(--line); }
/* Severity dots and the "New" tag in the findings list. */
:root { --dot-c: #b83a17; --dot-h: #f6663a; --dot-m: #f2be22; --dot-l: #97948c; --new-bg: #b5daf5; --new: #1f4e7a; --ok-bg: oklch(87% 0.1 160); --ok: oklch(42% 0.09 162); }
body.vscode-dark { --new-bg: #1f4e7a; --new: #b5daf5; }
body.vscode-high-contrast, body.vscode-high-contrast-light { --new-bg: transparent; --new: var(--vscode-foreground); --ok-bg: transparent; --ok: var(--vscode-foreground); }
`;
