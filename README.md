# Changed Reference Linker

A modified edition of [Zotero Reference Linker](https://github.com/ottersem/zotero-reference-linker), maintained by **gesongping**.

**Original project:** [ottersem/zotero-reference-linker](https://github.com/ottersem/zotero-reference-linker), created by **ottersem (Seungmin Park)**. Many thanks for the original implementation. This fork is an independent derivative and is not an official release of the original project.

The original project is released under the **MIT License**. Its original copyright notice (`Copyright (c) 2026 Seungmin Park`) and the complete license terms are preserved in [LICENSE](LICENSE). The modifications are also distributed under the MIT License.

## Features

- Recognizes numbered and author–year bibliographies in PDF documents.
- Highlights complete reference entries, including references continued across pages, while avoiding detected page headers and footers.
- Uses subtle light gray for references without a confident library match and light yellow for those matched to Zotero items.
- Opens linked library items or PDFs and provides search/copy actions for references without matches.
- Matches Zotero library metadata with conservative title/author/year checks, across accessible libraries.
- Displays **扫描 / 匹配 / 模糊** (scanned / matched / ambiguous) counters inline on the PDF toolbar. Click **Ref** to refresh.
- Does **not** require or call Ethereal Reference.

## Install

Requires **Zotero 10.0.x** (verified by the maintainer's testing on Zotero 10.0.7; compatibility outside that line is not established).

1. Download `Changed-Reference-Linker-1.0.0.xpi` from this repository's Releases.
2. In Zotero choose **Tools → Plugins → gear menu → Install Plugin From File**.
3. Restart Zotero if requested.

The extension has a **new plugin ID** (`changed-reference-linker@gesongping.github.io`). To avoid duplicate toolbars and overlapping highlights, **disable or uninstall the original Reference Linker and earlier modified versions** before enabling this one. Ethereal Reference can remain installed.

## Update manifest

The plugin manifest points to `https://raw.githubusercontent.com/gesongping/Changed-Reference-Linker/main/updates.json`. This is a proposed publishing location, **not a working automatic-update service until the repository and `updates.json` are published**. If publishing under a different username or repository name, edit the `update_url` and `homepage_url` fields in `manifest.json` before building. No upstream update URL is used.

## Build from the published source

This repository includes the readable runtime JavaScript used in the XPI (`content/reference-linker.js`), the Zotero bootstrap, icons, manifest, and packaging script. Run:

```bash
python3 scripts/build.py
```

This creates `dist/Changed-Reference-Linker-1.0.0.xpi`. It requires only the Python standard library. This distribution uses the modified bundled JavaScript as its working source rather than claiming that the upstream TypeScript sources reproduce the modified build.

## Limitations

PDF text extraction and layout vary: scanned/image-only PDFs, complex multicolumn layouts, and unusual bibliography formats may require manual checking. A gray highlight does not necessarily mean that a citation is absent from the library. The plugin highlights the reader UI; it does not alter the original PDF.

## Acknowledgments

Changed Reference Linker is a modified and enhanced version of [Reference Linker](https://github.com/ottersem/zotero-reference-linker), originally developed by **Seungmin Park (ottersem)**.

We sincerely thank the original author for making the project publicly available under the MIT License. The original copyright notice and license terms are retained in the [LICENSE](LICENSE) file.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
