# VAKT

Find the functions most likely to be vulnerable, while you write them. VAKT scores every function with DOM-0.8B, a security model that runs **on your machine**. Cloud review is on by default: it sends anonymised functions and a code graph of the repository to Vaktex for a second opinion, and uses them to train Vaktex models. Turn on `vakt.fullyLocal` to send nothing (see [Privacy](#privacy)).

Flagged functions are marked in the editor. Open one to see what the weakness is, the code that was scored and how confident the model is, then hand it to your coding agent to review and fix.

## Features

- **Scan as you type.** About a second and a half after you stop typing, the file you are editing is scored, unsaved changes included. Only the functions you changed are re-scored, in tens of milliseconds.
- **Findings as they are found.** A workspace scan lists each finding the moment it is scored.
- **Results that persist.** Past results show as soon as you open a project, with no scan. Files you changed since are left out until they are scanned again.
- **A finding panel** with the CWE and what it means, the scored code, and the model's scores for each vulnerability family.
- **Resolve with your agent.** In Cursor, *Resolve* opens an agent chat with a review-and-fix prompt ready to send. In VS Code it asks Copilot in agent mode. Anywhere else it copies the prompt.
- **Review** above each finding and as a quick fix (⌘. / Ctrl+.), plus entries in the Problems panel.
- **A findings sidebar** grouped by file or by family, with severity filters and search.
- Light, dark and high-contrast themes.

A score is a lead, not a verdict: the model reads one function at a time, so check callers, reachability and configuration. A low score is not proof of safety.

## Requirements

VAKT uses the free [`vakt`](https://github.com/Vaktex/vakt) command-line scanner, which runs the model on a Mac with Apple silicon (Metal), on Linux with an NVIDIA GPU (CUDA), or on the CPU.

1. Install it:

   ```bash
   curl -fsSL https://get.vaktex.com/oss-vakt | sh
   ```

2. Open the VAKT sidebar and follow the checklist. **Set up model** signs you in to Hugging Face and downloads DOM-0.8B (about 1.5 GB). It is a gated model: request access at [huggingface.co/vaktex/dom-oss-0.8b](https://huggingface.co/vaktex/dom-oss-0.8b) first. **Sign in** (optional, free) raises your cloud review allowance; the step is left out when cloud review is off.

3. Click **Scan workspace**.

Live scanning, streaming and saved results need `vakt` 0.3.0 or later. With an older version, files are scanned on save.

## Settings

| Setting | Default | |
|---|---|---|
| `vakt.scanOnType` | on | Score the file you are editing as you type |
| `vakt.scanOnSave` | on | Score a file when it is saved |
| `vakt.scanWorkspaceOnOpen` | off | Scan each folder when it is opened |
| `vakt.threshold` | 0.95 | Severity a function needs to be flagged |
| `vakt.minConfidence` | 0.9 | Score its vulnerability family needs |
| `vakt.path` | | Path to `vakt`, if it is not on your PATH or in `~/.local/bin` |
| `vakt.improvedResponses` | on | Cloud review (anonymized): Vaktex cloud models double-check findings; what is sent trains Vaktex models |
| `vakt.fullyLocal` | off | Send nothing and never contact the cloud |

Changing the thresholds re-filters existing results immediately, without a re-scan.

## Privacy

Scoring is local: DOM-0.8B runs on your machine through `vakt`. **Cloud review is on by default** and sends code to Vaktex. The only switch that sends nothing is **Fully local** (`vakt.fullyLocal`); `vakt.improvedResponses` turns cloud review off on its own.

### What cloud review does

Vaktex cloud models review each flagged function, every function in a file you *Rescan*, and functions DOM-0.8B passed that look security-relevant (request handlers, auth, SQL, shell commands and the like). A finding the review rejects is not shown, one it relabels shows its label, and one it finds is added. Each function is looked up by an MD5 hash of its anonymised code first; if it has been reviewed before, by anyone, that answer is used and the code is not sent again. Nothing is shown before it has been reviewed: if the cloud is unreachable or busy, findings wait and are asked about again (the status bar says how many). Over a limit that lasts hours, you get DOM-0.8B's results as usual.

In an editor with no coding agent, *Resolve* asks the cloud for a fix to that one function and shows it as a diff, which you accept or reject. Your real names are put back into the fix on your machine.

### What is sent

- Individual functions, with their language and DOM-0.8B's scores.
- A code graph of the repository: functions, calls, imports, routes, data access and the framework in use.
- Per-language coverage (how many files, functions and calls were extracted and resolved).
- Findings you *Ignore* or *Rescan*, with what they said.

### How it is anonymised

Everything is anonymised on your machine before it is sent. Keys, tokens, URL credentials and email addresses are removed, and comments are dropped. Names, words in strings and path segments that are specific to your project are replaced by numbered placeholders; common programming words (`user`, `request`, `query` and the like) stay. Long numbers are replaced. The table that maps placeholders back to your names stays in memory on your machine and is never sent. The repository is identified by a salted hash, not its remote URL or folder.

The structure of the code stays, because that is what the review needs. A distinctive proprietary algorithm could therefore still be recognised by someone who holds the original. This is close to anonymous, not perfectly anonymous. If that matters for a project, turn on Fully local.

### What it is used for and how long it is kept

What is sent is used to train Vaktex models and is kept for up to 24 months. Training records carry no user identifier: no IP address, install id or account. Because of that, they cannot be found per user, and deleting them on request is not possible. To enforce limits and stop abuse, Vaktex keeps short-lived counters keyed by a hashed IP address, install id or account: usage for 7 days, spend for 3 months, ignore votes for 90 days, and the owner of a code graph upload for 7 days after it is processed.

Processing runs on Cloudflare (Workers AI, R2, D1 and Queues).

### Monthly limits

Cloud review is free up to a monthly limit of cloud model use, and a free Vaktex account (*VAKT: Sign In to Vaktex*) raises it. After the limit, cloud review stops until the 1st of the next month (UTC) and local results continue. Payment is not available yet.

### Signing in

A free Vaktex account raises that limit and shows your plan and usage (this month's spend, today's requests) at the foot of the VAKT sidebar. It sends no code by itself: cloud requests carry a sign-in token so they count against your account rather than this install. The token is kept in the editor's secret storage. *Sign out* in the sidebar, or *VAKT: Sign Out of Vaktex*, revokes it.

### Fully local

**Fully local** (`vakt.fullyLocal`) turns all of this off: no cloud review, code graph, cloud fixes or training, and the extension makes no network requests at all.

Results are kept in a `.vakt` folder in each project, which is ignored by git and signed so that a repository cannot ship results of its own.

## Licence

Apache 2.0. See `LICENSE` and `NOTICE` for third-party components.
