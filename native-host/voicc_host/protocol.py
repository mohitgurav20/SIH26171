"""Chrome native-messaging transport (phases 13 and 28).

Wire format is fixed by Chrome: a 4-byte native-endian unsigned length
prefix followed by that many bytes of UTF-8 JSON, over stdin/stdout.

Two things bite people here and both are handled below:
  * stdout must be opened in binary mode, and nothing else in the process may
    ever print to it — a stray print() corrupts the stream. `install_stdio_guard`
    redirects sys.stdout to stderr so an accidental print is survivable.
  * Chrome caps a single message from the host at 1 MB. Screenshot payloads
    blow through that, so oversized frames are rejected with a clear error
    rather than silently truncated.
"""
from __future__ import annotations

import json
import struct
import sys
import threading
from typing import Any, BinaryIO, Iterator

from .errors import ProtocolError

# Chrome's documented limits.
MAX_MESSAGE_FROM_HOST = 1024 * 1024          # 1 MB, host -> Chrome
MAX_MESSAGE_TO_HOST = 64 * 1024 * 1024       # 64 MB, Chrome -> host
_LEN = struct.Struct("=I")                   # native byte order, 4 bytes


def install_stdio_guard() -> BinaryIO:
    """Take exclusive ownership of the real stdout and hand it back.

    Everything else in the process gets stderr, so a forgotten print()
    lands in the log instead of corrupting the message stream.
    """
    raw = sys.stdout.buffer
    sys.stdout = sys.stderr  # type: ignore[assignment]
    return raw


def read_message(stream: BinaryIO) -> dict[str, Any] | None:
    """Read one framed message. Returns None at clean end-of-stream."""
    header = stream.read(4)
    if not header:
        return None                      # Chrome closed the pipe: normal exit.
    if len(header) < 4:
        raise ProtocolError(f"truncated length prefix ({len(header)} bytes)")
    (length,) = _LEN.unpack(header)
    if length > MAX_MESSAGE_TO_HOST:
        raise ProtocolError(f"inbound message too large: {length} bytes")
    body = stream.read(length)
    if len(body) != length:
        raise ProtocolError(
            f"truncated body: expected {length}, read {len(body)}")
    try:
        message = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"malformed JSON frame: {exc}") from exc
    if not isinstance(message, dict):
        raise ProtocolError("top-level message must be a JSON object")
    return message


def encode_message(payload: dict[str, Any]) -> bytes:
    body = json.dumps(payload, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")
    if len(body) > MAX_MESSAGE_FROM_HOST:
        raise ProtocolError(
            f"outbound message too large: {len(body)} bytes "
            f"(Chrome caps host messages at {MAX_MESSAGE_FROM_HOST})")
    return _LEN.pack(len(body)) + body


class MessageWriter:
    """Serializes writes so streamed partial results can't interleave.

    Phase 108 streams progress frames from a worker thread while the main
    thread may also emit responses; both go through this lock.
    """

    def __init__(self, stream: BinaryIO):
        self._stream = stream
        self._lock = threading.Lock()

    def send(self, payload: dict[str, Any]) -> None:
        frame = encode_message(payload)
        with self._lock:
            self._stream.write(frame)
            self._stream.flush()


def iter_messages(stream: BinaryIO) -> Iterator[dict[str, Any]]:
    while True:
        message = read_message(stream)
        if message is None:
            return
        yield message
