"""Every code point through each non-trnorm step of docs/py/ahenk_front.py, for front_exhaustive.mjs to compare
with docs/js/front-native.js. The per-code-point tests cover what a corpus rarely hits: str.isspace/split/strip,
lower(), NFKD and unicodedata.combining, the UNSAFE class and lone surrogates, LETTER, the \\S cut, piece().

    python3 tools/parity/front_exhaustive.py DIR [--vocab MODEL.json]  ->  DIR/<test>.json (one result per code point)
"""
import argparse
import json
import os
import random
import sys
import time
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'docs', 'py'))
import ahenk_front as F  # noqa: E402

VOCAB = ('/tmp/claude-0/-home-user-ahenk-cep-pdfreader/9d20a4c9-d948-50ce-a350-236eed51946b/scratchpad/hf/'
         'ahenk-cep.json')
PROBE_A, PROBE_B = 'a' * 170 + ' ' + 'b' * 5, ' ' + 'c' * 100  # the code point sits at 176, a space after it


class Universal:  # a vocabulary that has everything: alphabet's character mapping on its own
    def __contains__(self, x):
        return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--vocab', default=VOCAB)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    letters, u = frozenset(json.load(open(a.vocab, encoding='utf-8'))['vocab']), Universal()
    every = range(0x110000)
    nosur = [c for c in every if not 0xD800 <= c < 0xE000]

    def run(name, fn, cps):
        t0, out = time.time(), []
        for c in cps:
            try:
                out.append(fn(chr(c)))
            except Exception as e:  # noqa: BLE001
                out.append({'error': type(e).__name__})
        with open(f'{a.out}/{name}.json', 'w', encoding='ascii') as f:
            json.dump(out, f, ensure_ascii=True)
        print(f'{name}: {len(out)} code points, {time.time() - t0:.1f}s', file=sys.stderr)

    with open(f'{a.out}/meta.json', 'w', encoding='ascii') as f:
        json.dump({'unidata_version': unicodedata.unidata_version, 'python': sys.version.split()[0],
                   'unassigned': [c for c in nosur if unicodedata.category(chr(c)) == 'Cn']}, f)
    run('blocks', lambda c: [list(F.blocks(c)), list(F.blocks('a' + c + 'a'))], nosur)
    run('alphabet_model', lambda c: F.alphabet(c, letters), nosur)
    run('alphabet_universal', lambda c: F.alphabet('a' + c + 'b', u), nosur)
    run('frontend', lambda c: F.frontend('x' + c + 'a', letters), every)
    run('chunk', lambda c: F.chunk(c, 1.0), nosur)
    run('cut', lambda c: [(len(t), p) for t, p in F.chunk(PROBE_A + c + PROBE_B, 1.0)][:1], nosur)
    run('piece', lambda c: F.piece('a ' + c + ' b' + c, {'a': 5, ' ': 2, c: 9}), nosur)

    # lower() looks at context (final sigma): whole strings of cased, case-ignorable and other characters
    rng = random.Random(7)
    pool = ['Σ', 'σ', 'ς', 'Α', 'a', 'A', ' ', '.', "'", '́', '­', ':', '1', 'ǅ', 'İ', 'I', 'ͅ', '’',
            'ʼ', '‍', 'Ω', '\U0001d400', 'ﬁ', '̇']
    texts = [''.join(rng.choice(pool) for _ in range(rng.randint(1, 12))) for _ in range(50000)]
    with open(f'{a.out}/sigma.json', 'w', encoding='ascii') as f:
        json.dump([texts, [F.alphabet(t, u) for t in texts]], f, ensure_ascii=True)


if __name__ == '__main__':
    main()
