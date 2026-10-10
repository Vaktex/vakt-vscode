# Changelog

## 0.1.0

First release.

- Findings sidebar grouped by file or by vulnerability family, with severity filters, a filter box and a setup checklist before the first scan.
- Finding panel with the CWE description, highlighted code, family scores against their cut-offs, and *Resolve*, *Rescan* and *Ignore*.
- *Resolve* hands the finding to your editor's agent to review and fix: a pre-filled agent chat in Cursor, Copilot agent mode in VS Code.
- Scan as you type through `vakt serve`, with only changed functions re-scored.
- Findings stream in as a workspace scan runs, and past results load at startup from `.vakt`.
- *Review* code lens and quick fix on each finding; Problems panel entries.
- Light, dark and high-contrast themes.
