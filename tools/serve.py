#!/usr/bin/env python3
"""Serve docs/ on localhost for testing.

    python3 tools/serve.py [--port 8000] [--isolate]

Plain mode is what GitHub Pages gives (no COOP/COEP headers; docs/coi-serviceworker.js adds them in browsers that
allow service workers). --isolate sends Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy itself, so
WebAssembly gets its threads even where service workers are off.
"""

from __future__ import annotations

import argparse
import functools
import http.server
from pathlib import Path

SITE = Path(__file__).resolve().parents[1] / "docs"


class Handler(http.server.SimpleHTTPRequestHandler):
    isolate = False
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript",
                      ".js": "text/javascript", ".py": "text/plain; charset=utf-8", ".json": "application/json",
                      ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml"}

    def end_headers(self):
        if self.isolate:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):  # quiet
        pass


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--isolate", action="store_true")
    a = ap.parse_args(argv)
    Handler.isolate = a.isolate
    httpd = http.server.ThreadingHTTPServer((a.bind, a.port), functools.partial(Handler, directory=str(SITE)))
    print(f"http://{a.bind}:{a.port}/  ({'isolated' if a.isolate else 'as GitHub Pages serves it'})")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
