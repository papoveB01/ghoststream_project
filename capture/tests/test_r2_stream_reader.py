"""Coverage for _HttpxStreamReader (src/r2.py).

Why this exists: upload_video_from_url pipes a Recall.ai recording (1-2h,
multi-GB) straight into R2 via boto3's upload_fileobj, which pulls fixed-size
chunks through this adapter's read(size). The container's /tmp is a 64MB
tmpfs, so the whole point of this class is that it must never materialise
the full body — only ever a few chunks live in `_buf` at once. These tests
drive read() over a fake chunk iterator (no real network/httpx.Response) and
assert both the read(size) contract and that it doesn't over-pull chunks.
"""
from src.r2 import _HttpxStreamReader


class _FakeResponse:
    """Stand-in for httpx.Response — only .iter_bytes() is used by the class
    under test, and it must return a fresh iterator each call site expects."""

    def __init__(self, chunks):
        self._chunks = chunks

    def iter_bytes(self):
        return iter(self._chunks)


def test_read_exact_and_partial_chunk_boundaries():
    chunks = [b"a" * 10, b"b" * 10, b"c" * 10]
    reader = _HttpxStreamReader(_FakeResponse(chunks))

    assert reader.read(10) == b"a" * 10
    assert reader.read(5) == b"b" * 5
    assert reader.read(5) == b"b" * 5
    assert reader.read(10) == b"c" * 10
    assert reader.read(10) == b""  # EOF: iterator exhausted, buffer empty


def test_read_negative_size_drains_remaining_buffer_and_iterator():
    chunks = [b"x" * 4, b"y" * 4]
    reader = _HttpxStreamReader(_FakeResponse(chunks))

    assert reader.read(2) == b"xx"
    # read(-1) (boto3's "read the rest") must return whatever is left,
    # buffered bytes first, then draining the rest of the iterator.
    assert reader.read(-1) == b"xxyyyy"


def test_read_default_arg_behaves_like_negative_size():
    reader = _HttpxStreamReader(_FakeResponse([b"only-chunk"]))

    assert reader.read() == b"only-chunk"


def test_read_never_pulls_more_chunks_than_needed_to_satisfy_the_call():
    # The load-bearing assertion: a small read() must not drag the rest of a
    # multi-GB body into memory. Track how many chunks the generator actually
    # yields versus how many exist.
    pulled = []

    def gen():
        for i in range(1000):
            pulled.append(i)
            yield b"z" * 1024  # 1000 * 1KB — would be ~1MB fully materialised

    class _StreamingFakeResponse:
        def iter_bytes(self):
            return gen()

    reader = _HttpxStreamReader(_StreamingFakeResponse())
    data = reader.read(1024)

    assert data == b"z" * 1024
    assert len(pulled) == 1  # exactly one chunk pulled — no eager materialisation


def test_read_across_many_small_chunks_pulls_only_as_needed():
    # Chunk size smaller than the requested read: must pull several chunks,
    # but stop as soon as the request is satisfied (not drain everything).
    pulled = []

    def gen():
        for i in range(100):
            pulled.append(i)
            yield b"q"  # 1-byte chunks

    class _StreamingFakeResponse:
        def iter_bytes(self):
            return gen()

    reader = _HttpxStreamReader(_StreamingFakeResponse())
    data = reader.read(10)

    assert data == b"q" * 10
    assert len(pulled) == 10  # pulled exactly enough 1-byte chunks, no more
