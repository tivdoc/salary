# Embedded Hebrew report font

`DejaVuSans.ttf` is the only font embedded by the canonical Hebrew PDF renderer.

- Family: DejaVu Sans
- Upstream release: 2.37
- Upstream: https://github.com/dejavu-fonts/dejavu-fonts/releases/tag/version_2_37
- Repository SHA-256: `7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954`
- Local acquisition source: the pinned Codex Poppler runtime at `Library/share/fonts/DejaVuSans.ttf`
- License: Bitstream Vera license; DejaVu changes are public domain; relevant Arev notice retained

The application reads this repository-local byte copy, verifies the pinned SHA-256 before every build, and embeds the complete font into the PDF. It performs no font download or remote lookup at runtime.
