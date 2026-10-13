# Changelog

## Unreleased

- **Anonymised cloud review.** Everything sent to the cloud is anonymised on your machine first: secrets and emails removed, comments dropped, names, string words and path segments specific to your project replaced by numbered placeholders, and long numbers replaced. Code structure stays, so this is close to anonymous, not perfectly. Cloud fixes put your real names back locally.
- **Code graph.** With cloud review on, the extension sends an anonymised graph of the repository (functions, calls, imports, routes, data access, framework) and per-language coverage, so the review can rank functions by how they are reached.
- **Training disclosure.** What cloud review sends is used to train Vaktex models and kept for up to 24 months, with no user identifier. The settings, README and Marketplace description now say so. `vakt.fullyLocal` is the only switch that sends nothing.
- **Monthly limits.** Cloud use is free up to a monthly limit, raised by a free Vaktex account with a verified email. Over the limit, cloud review stops until the 1st and local results continue.
- **Free account** with *VAKT: Sign In to Vaktex*, also a step in the sidebar checklist. The sidebar shows the plan, this month's usage and today's requests. The token is kept in VS Code's secret storage; signing in sends no code by itself.
- Hitting today's limit offers to sign in when signing in would raise it.
- No model name is shown anywhere in the extension; the cloud is "Vaktex cloud models".
- **Improved cloud responses** (on by default, `vakt.improvedResponses`): a larger cloud model double-checks each finding before it is shown, drops the ones it rejects and relabels the ones it classifies differently. *Rescan* re-reviews every function in the file and can add findings DOM-0.8B missed. Code is redacted and sent one function at a time, with no file names or paths.
- Cloud review looks functions up by hash first and only sends code it has not seen; verdicts improve over time as the cloud model is upgraded or findings are disputed.
- Functions DOM-0.8B passed that look security-relevant from their path and code are checked by the cloud too.
- **Cloud fixes**: in an editor with no coding agent, *Resolve* gets a fix from the cloud and shows it as a diff to accept or reject.
- With improved cloud responses on, ignoring a finding or rescanning its file reports it (the redacted function and what the finding said) to help improve DOM-0.8B.
- **Fully local** (`vakt.fullyLocal`): never contact the cloud.
- Any cloud error, rate limit or outage falls back to DOM-0.8B's own results.

## 0.1.0

First release.

- Findings sidebar grouped by file or by vulnerability family, with severity filters, a filter box and a setup checklist before the first scan.
- Finding panel with the CWE description, highlighted code, family scores against their cut-offs, and *Resolve*, *Rescan* and *Ignore*.
- *Resolve* hands the finding to your editor's agent to review and fix: a pre-filled agent chat in Cursor, Copilot agent mode in VS Code.
- Scan as you type through `vakt serve`, with only changed functions re-scored.
- Findings stream in as a workspace scan runs, and past results load at startup from `.vakt`.
- *Review* code lens and quick fix on each finding; Problems panel entries.
- Light, dark and high-contrast themes.
