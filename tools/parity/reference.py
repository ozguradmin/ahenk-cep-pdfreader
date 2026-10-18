#!/usr/bin/env python3
"""CPython reference for the parity check: docs/py's ahenk_front.prepare() on every case of a corpus.

    python3 tools/parity/reference.py DIR [--out ref.jsonl] [--vocab MODEL.json] [--jobs N]

DIR/corpus.jsonl -> DIR/<out>: one line per case, in corpus order: {"id", "spoken", "pieces"} (prepare()'s JSON,
parsed) or {"id", "error": "<ExceptionType>"} where Python raises ("NeverReturns" where prepare() would loop forever:
never_returns.py). DIR/<out>.meta.json records the interpreter,
its Unicode version and the vocabulary. The site runs this Python in Pyodide (Python 3.12, Unicode 15.0):
pyodide_ref.mjs makes the same file there, and run.sh uses that one unless REF=cpython.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import multiprocessing
import os
import sys
import time
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
DEFAULT_VOCAB = os.environ.get(
    'AHENK_VOCAB',
    '/tmp/claude-0/-home-user-ahenk-cep-pdfreader/9d20a4c9-d948-50ce-a350-236eed51946b/scratchpad/hf/ahenk-cep.json',
)

_front = None
_vocab = None


def _init(vocab):
    global _front, _vocab
    sys.dont_write_bytecode = True  # never leave __pycache__ in docs/py
    sys.path.insert(0, os.path.join(REPO, 'docs', 'py'))
    sys.path.insert(0, HERE)
    import ahenk_front
    import never_returns

    never_returns.guard(ahenk_front)
    _front, _vocab = ahenk_front, vocab


def _dump(obj):
    """One JSON line; UTF-8 unless a string holds a lone surrogate (then \\u escapes, which JSON.parse reads back)."""
    try:
        line = json.dumps(obj, ensure_ascii=False, separators=(',', ':'))
        line.encode('utf-8')
        return line
    except UnicodeEncodeError:
        return json.dumps(obj, ensure_ascii=True, separators=(',', ':'))


def _run(line):
    case = json.loads(line)
    try:
        return False, _dump({'id': case['id'], **json.loads(_front.prepare(case['text'], case['speed'], _vocab))})
    except Exception as e:  # the JS port must throw here too; the type is recorded for the report
        return True, _dump({'id': case['id'], 'error': type(e).__name__})


def vocab_sha256(vocab):
    """Hash of the vocabulary as JSON.stringify writes it (check.mjs compares it with the one it loads)."""
    return hashlib.sha256(json.dumps(vocab, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('dir')
    ap.add_argument('--out', default='ref.jsonl')
    ap.add_argument('--vocab', default=DEFAULT_VOCAB, help='model JSON with a "vocab" list (or a JSON list)')
    ap.add_argument('--jobs', type=int, default=min(8, os.cpu_count() or 1))
    a = ap.parse_args(argv)

    raw = json.load(open(a.vocab, encoding='utf-8'))
    vocab = raw['vocab'] if isinstance(raw, dict) else raw
    with open(os.path.join(a.dir, 'corpus.jsonl'), encoding='utf-8') as f:
        lines = [line for line in f if line.strip()]

    t0 = time.perf_counter()
    dst = os.path.join(a.dir, a.out)
    errors = 0
    with open(dst + '.tmp', 'w', encoding='utf-8', newline='\n') as fo:
        if a.jobs > 1:
            ctx = multiprocessing.get_context('fork' if sys.platform != 'win32' else 'spawn')
            with ctx.Pool(a.jobs, initializer=_init, initargs=(vocab,)) as pool:
                results = pool.imap(_run, lines, chunksize=4)  # small chunks: a few cases take seconds each
                for err, out in results:
                    errors += err
                    fo.write(out + '\n')
        else:
            _init(vocab)
            for line in lines:
                err, out = _run(line)
                errors += err
                fo.write(out + '\n')
    os.replace(dst + '.tmp', dst)
    secs = time.perf_counter() - t0
    meta = {
        'engine': 'cpython',
        'python': sys.version.split()[0],
        'unicode': unicodedata.unidata_version,
        'vocab_sha256': vocab_sha256(vocab),
        'cases': len(lines),
        'errors': int(errors),
        'seconds': round(secs, 2),
    }
    with open(dst + '.meta.json', 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=1)
    print(json.dumps({'ref': dst, **meta}))


if __name__ == '__main__':
    main()
