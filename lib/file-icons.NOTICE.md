# File icons — third-party notice

`file-icons.generated.ts` inlines a curated subset of the icon set from
[material-icon-theme](https://github.com/material-extensions/vscode-material-icon-theme)
(npm package `material-icon-theme`), © Material Extensions, MIT licensed.

Only the icons this office's file types need are included (see
`lib/file-icons.ts` for the extension/filename/folder-name mapping); the full
set (~1250 SVGs) was not bundled to keep the plugin small. Regenerate with the
one-off script that produced this file if the curated list needs to grow —
`npm pack material-icon-theme`, extract, base64-encode the wanted
`icons/<name>.svg` files into `FILE_ICON_DATA`.
