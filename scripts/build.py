#!/usr/bin/env python3
"""Package Changed Reference Linker for Zotero using Python's standard library."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
assert manifest['applications']['zotero'].get('update_url', '').startswith('https://'), 'Missing Zotero update_url'
name = f"Changed-Reference-Linker-{manifest['version']}.xpi"
dest = root / 'dist' / name
dest.parent.mkdir(parents=True, exist_ok=True)
files = ['manifest.json', 'bootstrap.js', 'icon.png', 'icon@2x.png', 'content/reference-linker.js', 'LICENSE', 'README.md']
with ZipFile(dest, 'w', ZIP_DEFLATED) as z:
    for file in files:
        z.write(root / file, file)
with ZipFile(dest) as z:
    assert z.testzip() is None
print(dest)
