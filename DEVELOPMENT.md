# Developing VAKT for VS Code

```bash
npm install
npm test                                  # unit tests (fake vakt binary)
VAKT_BIN=~/.local/bin/vakt npm test       # + integration test against the real model
npm run package                           # vakt-vscode-0.1.0.vsix
```

Press F5 in this folder to start an Extension Development Host.

Only `extension.ts`, `ui.ts`, `panel.ts` and `listView.ts` import `vscode`. Everything else (`cli`, `report`, `store`, `scheduler`, `present`, `families`, `detailHtml`, `listHtml`, `highlight`, `theme`) is plain Node and covered by `node --test`.

`src/families.ts` mirrors `internal/labels` at the pinned weights. When `brand.ModelCommit` moves, update it at the same time.


## Publish

Bump `version` in `package.json` and add a `CHANGELOG.md` entry, then:

```bash
npx vsce login vaktex              # once, with an Azure DevOps token (Marketplace: Manage)
npm run publish:vscode             # Visual Studio Marketplace (VS Code)
OVSX_PAT=<token> npm run publish:openvsx   # Open VSX (Cursor, Windsurf, VSCodium, Gitpod)
```

`ovsx` reads the token from `OVSX_PAT`. The listing page is `README.md`; keep developer notes here.
