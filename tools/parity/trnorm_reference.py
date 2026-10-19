#!/usr/bin/env python3
"""CPython reference for the trnorm API itself: normalize, normalize_for_eval and inverse_normalize.

    python3.12 tools/parity/trnorm_reference.py DIR [--out trnorm_ref.jsonl] [--jobs N]

DIR/corpus.jsonl -> DIR/<out>, one line per case: {"id", "normalize", "eval", "itn", "itn_spoken", "itn_eval"}, each
the function's result, {"error": "<ExceptionType>"}, or null where it took more than 20 s; itn_spoken and itn_eval are inverse_normalize() of the case's
spoken and eval forms (ASR-like input: words where the text had digits). trnorm_check.mjs compares the port with
it. Run it with Python 3.12 (Unicode 15.0, as Pyodide): 3.13 knows Unicode 15.1.
"""

from __future__ import annotations

import argparse
import json
import multiprocessing
import os
import re
import signal
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
T = None
LIMIT = 20
_SURROGATE = re.compile('[\ud800-\udfff]')


def _init():
    global T
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.join(REPO, 'docs', 'py'))
    import trnorm

    T = trnorm


class _Slow(Exception):
    pass


def _alarm(*_):
    raise _Slow


def _call(fn, text):
    # inverse_normalize is cubic in a run of number words ("bir bir bir ..." from a long digit string): a call that
    # takes more than LIMIT seconds is left out (null), as Python gives no answer to compare with
    signal.signal(signal.SIGALRM, _alarm)
    signal.alarm(LIMIT)
    try:
        return fn(text)
    except _Slow:
        return None
    except Exception as e:  # noqa: BLE001 - the type is the result
        return {'error': type(e).__name__}
    finally:
        signal.alarm(0)


def _dump(obj):
    try:
        line = json.dumps(obj, ensure_ascii=False, separators=(',', ':'))
        line.encode('utf-8')
        return line
    except UnicodeEncodeError:
        return json.dumps(obj, ensure_ascii=True, separators=(',', ':'))


def _run(line):
    case = json.loads(line)
    text = case['text']
    out = {'id': case['id']}
    out['normalize'] = _call(T.normalize, text)
    out['eval'] = _call(T.normalize_for_eval, text)
    out['itn'] = _call(T.inverse_normalize, text)
    # not for a form with a surrogate code point in it: two lone ones side by side are one astral character once
    # the form is written to JSON (and in any JS string), so the port could not be given what Python was
    for k, form in (('itn_spoken', out['normalize']), ('itn_eval', out['eval'])):
        ok = isinstance(form, str) and not _SURROGATE.search(form)
        out[k] = _call(T.inverse_normalize, form) if ok else None
    return _dump(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dir')
    ap.add_argument('--out', default='trnorm_ref.jsonl')
    ap.add_argument('--jobs', type=int, default=os.cpu_count() or 2)
    a = ap.parse_args()
    with open(os.path.join(a.dir, 'corpus.jsonl'), encoding='utf-8') as f:
        lines = [l for l in f.read().split('\n') if l]  # not splitlines(): a case may hold U+2028
    with multiprocessing.Pool(a.jobs, initializer=_init) as pool, open(os.path.join(a.dir, a.out), 'w', encoding='utf-8') as out:
        for row in pool.imap(_run, lines, chunksize=64):
            out.write(row + '\n')
    print(f'{len(lines)} cases -> {os.path.join(a.dir, a.out)} (Python {sys.version.split()[0]})')


if __name__ == '__main__':
    main()
