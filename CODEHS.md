# GEARS for CodeHS (modified version)

Copyright (C) 2026 CodeHS

This is a modified version of [GEARS](https://github.com/QuirkyCort/gears)
(upstream commit 20b8e87). It is distributed under the
[GNU General Public License, version 3](LICENSE), like the original.

CodeHS modified this work on 2026-10-16. The complete source for this version,
including the CodeHS modifications below, is available in this repository under
the GPL-3.0.

Changes from upstream:

- `public/codehs-bridge.js`: a postMessage bridge so a parent page can load a
  world and program, read the program back, and get run results.
  It only runs when the page is opened with `?embedOrigin=<parent origin>`.
- `public/index.html`: loads the bridge.

Serve `public/` as a static site on its own origin, for example:

    python3 -m http.server 8090 --directory public
