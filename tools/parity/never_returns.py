"""The one input the Python reference cannot answer: prepare() never returns, so the reference records that instead.

ahenk_front.chunk() at a speed under 1/180 (also 0, False, a negative speed) gets a limit of 0 or less: on a text with
any non-space character its loop then never shortens `rest`, and prepare() spins forever. The JavaScript port throws a
RuntimeError there (docs/js/front-native.js chunk) rather than hang the page. guard(ahenk_front) makes chunk() raise
NeverReturns in exactly that case, before looping, and changes nothing else: the limit is computed as chunk() computes
it first (so an OverflowError for speed -inf is raised as before), and every other call goes to the original chunk().
reference.py and pyodide_ref.mjs record the case as {"id", "error": "NeverReturns"}; check.mjs expects a RuntimeError.
"""


class NeverReturns(Exception):
    pass


def guard(front):
    chunk = front.chunk
    if getattr(chunk, 'never_returns_guard', False):
        return

    def guarded(text, speed):
        limit = int(min(front.MAX_LETTERS, front.LETTERS_PER_SECOND * front.MAX_SECONDS * speed))
        if limit <= 0 and text.strip():
            raise NeverReturns(f'chunk() at speed {speed!r} (limit {limit}) never returns')
        return chunk(text, speed)

    guarded.never_returns_guard = True
    front.chunk = guarded
