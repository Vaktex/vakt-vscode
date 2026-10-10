# VAKT

Find the functions most likely to be vulnerable, while you write them. VAKT scores every function with DOM-0.8B, a security model that runs **on your machine**: your code never leaves it.

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

2. Open the VAKT sidebar and follow the checklist. **Set up model** signs you in to Hugging Face and downloads DOM-0.8B (about 1.5 GB). It is a gated model: request access at [huggingface.co/vaktex/dom-oss-0.8b](https://huggingface.co/vaktex/dom-oss-0.8b) first.

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

Changing the thresholds re-filters existing results immediately, without a re-scan.

## Privacy

Scanning is local. The extension runs `vakt` on your machine and sends nothing anywhere. Results are kept in a `.vakt` folder in each project, which is ignored by git and signed so that a repository cannot ship results of its own.

## Licence

Apache 2.0. See `LICENSE` and `NOTICE` for third-party components.
