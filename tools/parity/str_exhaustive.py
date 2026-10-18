"""Every code point through the str methods trnorm's port re-implements (docs/js/trnorm/py.js, casing.js), for
str_exhaustive.mjs to compare: lower(), upper(), the final sigma context of lower() on both sides of the character,
isupper / islower / isalpha / isdecimal / isdigit / isalnum / isspace, and trnorm's tr_lower / tr_upper.

    python3.12 tools/parity/str_exhaustive.py DIR  ->  DIR/str.json (one row per code point, surrogates left out)
"""
import json
import os
import sys
import unicodedata

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'docs', 'py'))
from trnorm.casing import tr_lower, tr_upper  # noqa: E402


def row(c):
    flags = ''.join('1' if f() else '0' for f in (c.isupper, c.islower, c.isalpha, c.isdecimal, c.isdigit, c.isalnum,
                                                  c.isspace))
    return [c.lower(), c.upper(), ('Α' + c + 'Σ').lower(), (c + 'Σ').lower(), ('ΑΣ' + c).lower(), flags, tr_lower(c),
            tr_upper(c)]


def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    rows = [row(chr(c)) for c in range(0x110000) if not 0xD800 <= c <= 0xDFFF]
    with open(os.path.join(out, 'str.json'), 'w', encoding='ascii') as f:
        json.dump({'python': sys.version.split()[0], 'unicode': unicodedata.unidata_version, 'rows': rows}, f,
                  ensure_ascii=True)
    print(f'{len(rows)} code points, Python {sys.version.split()[0]}, Unicode {unicodedata.unidata_version}')


if __name__ == '__main__':
    main()
