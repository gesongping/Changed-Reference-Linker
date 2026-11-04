# Changed Reference Linker

A Zotero PDF reference-linking plugin maintained by **gesongping**. Based on [Zotero Reference Linker](https://github.com/ottersem/zotero-reference-linker) by **ottersem (Seungmin Park)**. This is an independent derivative, not an official release of the original plugin.

## Features (v1.2.0)

- Finds reference sections with common headings such as `References`, numbered `9. REFERENCES`, and `Bibliography`, with fallback detection when a heading is absent.
- Recognizes numbered labels (`[1]`, `(1)`, `1.`), alphanumeric labels (`[BGV14]`, `[ACC⁺21]`), and unnumbered author–year bibliographies.
- Highlights full reference entries using a shared boundary index, including entries that continue across pages.
- Filters detected running headers, footers, and standalone page numbers to reduce accidental highlighting.
- Keeps publication-year suffixes, `[Online]` information, URLs, and DOIs inside the reference highlight when they are part of the entry.
- Matches references against Zotero library items, supports opening matched items, and provides search/copy options for unmatched items.
- Displays scanned / matched / ambiguous counts in the PDF reader toolbar.

## Install

Requires **Zotero 10.0.x** as specified in the plugin manifest. Other Zotero versions have not been verified.

1. Download [`Changed-Reference-Linker-1.2.0.xpi`](https://github.com/gesongping/Changed-Reference-Linker/releases/download/v1.2.0/Changed-Reference-Linker-1.2.0.xpi) from the **v1.2.0** release.
2. In Zotero, open **Tools → Plugins**, then use the gear menu to select **Install Plugin From File**.
3. Choose the downloaded `.xpi` and restart Zotero if prompted.


## Acknowledgments

This repository is a modified and enhanced version of [Reference Linker](https://github.com/ottersem/zotero-reference-linker), originally developed by **Seungmin Park (ottersem)**. Many thanks to the original author. The original MIT copyright notice is preserved in `LICENSE`.

## License

MIT License. See [`LICENSE`](LICENSE).
