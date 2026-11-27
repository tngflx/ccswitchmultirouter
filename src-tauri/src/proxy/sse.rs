use bytes::{Buf, Bytes, BytesMut};
use std::borrow::Cow;

// Count wire bytes, including the blank-line delimiter. A stream may deliver
// arbitrarily many frames, but the decoder never retains more than one frame.
pub(crate) const MAX_SSE_FRAME_BYTES: usize = 8 * 1024 * 1024;

pub(crate) enum SseFrame {
    Complete(Bytes),
    Oversized,
}

pub(crate) struct BoundedSseFrames {
    pending: BytesMut,
    delimiter: SseDelimiter,
    discarding: bool,
    limit: usize,
    #[cfg(test)]
    scanned_bytes: usize,
}

#[derive(Default)]
struct SseDelimiter(u32);

impl SseDelimiter {
    fn push(&mut self, byte: u8) -> Option<usize> {
        self.0 = (self.0 << 8) | u32::from(byte);
        if self.0 & 0xffff == 0x0a0a {
            Some(2)
        } else if self.0 == 0x0d0a0d0a {
            Some(4)
        } else {
            None
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SseOrJsonMode {
    Unknown,
    Json,
    Sse,
}

pub(crate) enum SseOrJsonItem {
    Frame(Bytes),
    Json(Bytes),
    Oversized,
}

/// Bounded discriminator for endpoints that accept either an SSE stream or a
/// non-stream JSON document. Leading whitespace/BOM is retained only until the
/// first meaningful byte identifies the protocol; JSON is bounded as a whole,
/// while SSE is decoded one bounded frame at a time.
pub(crate) struct SseOrJsonFrames {
    mode: SseOrJsonMode,
    prefix: BytesMut,
    sse: BoundedSseFrames,
    bom_bytes: usize,
    closed: bool,
}

impl Default for SseOrJsonFrames {
    fn default() -> Self {
        Self {
            mode: SseOrJsonMode::Unknown,
            prefix: BytesMut::new(),
            sse: BoundedSseFrames::default(),
            bom_bytes: 0,
            closed: false,
        }
    }
}

impl SseOrJsonFrames {
    pub(crate) fn read(&mut self, input: &mut &[u8], eof: bool) -> Option<SseOrJsonItem> {
        const BOM: [u8; 3] = [0xef, 0xbb, 0xbf];

        if self.closed {
            return None;
        }
        if self.mode == SseOrJsonMode::Unknown {
            let mut count = 0;
            for &byte in input.iter() {
                if BOM[self.bom_bytes] == byte {
                    self.bom_bytes = (self.bom_bytes + 1) % BOM.len();
                } else if self.bom_bytes != 0 || !byte.is_ascii_whitespace() {
                    self.mode = if self.bom_bytes == 0 && matches!(byte, b'{' | b'[') {
                        SseOrJsonMode::Json
                    } else {
                        SseOrJsonMode::Sse
                    };
                    break;
                }
                if count == MAX_SSE_FRAME_BYTES - self.prefix.len() {
                    return self.oversized();
                }
                count += 1;
            }
            self.prefix.extend_from_slice(&input[..count]);
            *input = &input[count..];
        }

        match self.mode {
            SseOrJsonMode::Unknown => {
                self.closed = eof;
                None
            }
            SseOrJsonMode::Json => {
                if input.len() > MAX_SSE_FRAME_BYTES - self.prefix.len() {
                    return self.oversized();
                }
                self.prefix.extend_from_slice(input);
                *input = &[];
                self.closed = eof;
                eof.then(|| SseOrJsonItem::Json(std::mem::take(&mut self.prefix).freeze()))
            }
            SseOrJsonMode::Sse => {
                if !self.prefix.is_empty() {
                    let mut prefix = self.prefix.as_ref();
                    let original_len = prefix.len();
                    let frame = self.sse.read(&mut prefix);
                    let consumed = original_len - prefix.len();
                    self.prefix.advance(consumed);
                    if self.prefix.is_empty() {
                        self.prefix = BytesMut::new();
                    }
                    if let Some(frame) = frame {
                        return self.classify_frame(frame);
                    }
                }
                if let Some(frame) = self.sse.read(input) {
                    return self.classify_frame(frame);
                }
                if eof {
                    self.closed = true;
                    let pending = self.sse.take_pending();
                    if !pending.is_empty() {
                        return Some(SseOrJsonItem::Frame(pending));
                    }
                }
                None
            }
        }
    }

    fn classify_frame(&mut self, frame: SseFrame) -> Option<SseOrJsonItem> {
        match frame {
            SseFrame::Complete(frame) => Some(SseOrJsonItem::Frame(frame)),
            SseFrame::Oversized => self.oversized(),
        }
    }

    fn oversized(&mut self) -> Option<SseOrJsonItem> {
        self.closed = true;
        self.prefix = BytesMut::new();
        Some(SseOrJsonItem::Oversized)
    }
}

impl Default for BoundedSseFrames {
    fn default() -> Self {
        Self::new(MAX_SSE_FRAME_BYTES)
    }
}

impl BoundedSseFrames {
    fn new(limit: usize) -> Self {
        Self {
            pending: BytesMut::new(),
            delimiter: SseDelimiter::default(),
            discarding: false,
            limit,
            #[cfg(test)]
            scanned_bytes: 0,
        }
    }

    /// Advance through the chunk at most once. After reporting an oversized
    /// frame, discard until a blank line, never treating the suffix as an event.
    pub(crate) fn read(&mut self, input: &mut &[u8]) -> Option<SseFrame> {
        let bytes = *input;
        let mut start = 0;
        for (index, &byte) in bytes.iter().enumerate() {
            #[cfg(test)]
            {
                self.scanned_bytes += 1;
            }
            let end_of_frame = self.delimiter.push(byte).is_some();
            if self.discarding {
                if end_of_frame {
                    self.delimiter = SseDelimiter::default();
                    self.discarding = false;
                    start = index + 1;
                }
                continue;
            }

            if index - start == self.limit - self.pending.len() {
                self.pending = BytesMut::new();
                self.discarding = !end_of_frame;
                if end_of_frame {
                    self.delimiter = SseDelimiter::default();
                }
                *input = &bytes[index + 1..];
                return Some(SseFrame::Oversized);
            }

            if end_of_frame {
                self.pending.extend_from_slice(&bytes[start..=index]);
                self.delimiter = SseDelimiter::default();
                *input = &bytes[index + 1..];
                return Some(SseFrame::Complete(self.take_pending()));
            }
        }
        if !self.discarding {
            self.pending.extend_from_slice(&bytes[start..]);
        }
        *input = &[];
        None
    }

    pub(crate) fn take_pending(&mut self) -> Bytes {
        std::mem::take(&mut self.pending).freeze()
    }
}

#[inline]
pub(crate) fn strip_sse_field<'a>(line: &'a str, field: &str) -> Option<&'a str> {
    let value = line.strip_prefix(field)?.strip_prefix(':')?;
    Some(value.strip_prefix(' ').unwrap_or(value))
}

/// Frames live SSE text without rescanning an unfinished event on each chunk.
/// Delimiters are ASCII, so UTF-8 decoding can wait until the full block arrives.
#[derive(Default)]
pub(crate) struct TextSseFrames {
    buffer: BytesMut,
    block_start: usize,
    scan_offset: usize,
    delimiter: SseDelimiter,
    #[cfg(test)]
    scanned_bytes: usize,
}

impl TextSseFrames {
    pub(crate) fn push(&mut self, bytes: &[u8]) {
        self.buffer.advance(self.block_start);
        self.scan_offset -= self.block_start;
        self.block_start = 0;
        self.buffer.extend_from_slice(bytes);
    }

    pub(crate) fn next_block(&mut self) -> Option<Cow<'_, str>> {
        for &byte in &self.buffer[self.scan_offset..] {
            self.scan_offset += 1;
            #[cfg(test)]
            {
                self.scanned_bytes += 1;
            }
            if let Some(delimiter_len) = self.delimiter.push(byte) {
                let block = &self.buffer[self.block_start..self.scan_offset - delimiter_len];
                self.block_start = self.scan_offset;
                self.delimiter = SseDelimiter::default();
                return Some(String::from_utf8_lossy(block));
            }
        }
        None
    }

    pub(crate) fn tail(&self) -> Cow<'_, str> {
        String::from_utf8_lossy(&self.buffer[self.block_start..])
    }
}

/// Splits a complete SSE body into borrowed blocks and preserves any unterminated tail.
pub(crate) struct SseBlocks<'a> {
    remaining: &'a str,
    finished: bool,
    #[cfg(test)]
    scanned_bytes: usize,
}

impl<'a> SseBlocks<'a> {
    pub(crate) fn new(body: &'a str) -> Self {
        Self {
            remaining: body,
            finished: false,
            #[cfg(test)]
            scanned_bytes: 0,
        }
    }

    pub(crate) fn remaining(&self) -> &'a str {
        self.remaining
    }
}

impl<'a> Iterator for SseBlocks<'a> {
    type Item = &'a str;

    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }
        let bytes = self.remaining.as_bytes();
        for (index, &byte) in bytes.iter().enumerate() {
            #[cfg(test)]
            {
                self.scanned_bytes += 1;
            }
            let delimiter_len = match byte {
                b'\n' if bytes[index..].starts_with(b"\n\n") => 2,
                b'\r' if bytes[index..].starts_with(b"\r\n\r\n") => 4,
                _ => continue,
            };
            let block = &self.remaining[..index];
            self.remaining = &self.remaining[index + delimiter_len..];
            return Some(block);
        }
        self.finished = true;
        None
    }
}

/// Append raw bytes to a UTF-8 `String` buffer, correctly handling multi-byte
/// characters that are split across chunk boundaries.
///
/// `remainder` accumulates trailing bytes from the previous chunk that form an
/// incomplete UTF-8 sequence (at most 3 bytes under normal operation). On each
/// call the remainder is prepended to `new_bytes`, the longest valid UTF-8
/// prefix is appended to `buffer`, and any trailing incomplete bytes are saved
/// back into `remainder` for the next call.
///
/// A defensive guard discards `remainder` via lossy conversion if it ever
/// exceeds 3 bytes, which cannot happen with well-formed UTF-8 streams.
pub(crate) fn append_utf8_safe(buffer: &mut String, remainder: &mut Vec<u8>, new_bytes: &[u8]) {
    // Build the byte slice to decode: prepend any leftover bytes from previous chunk.
    let (owned, bytes): (Option<Vec<u8>>, &[u8]) = if remainder.is_empty() {
        (None, new_bytes)
    } else {
        // Defensive guard: remainder should never exceed 3 bytes (max incomplete
        // UTF-8 sequence is 3 bytes: a 4-byte char missing its last byte). If it
        // does, the stream is producing genuinely invalid bytes; flush them lossy
        // and start fresh.
        if remainder.len() > 3 {
            buffer.push_str(&String::from_utf8_lossy(remainder));
            remainder.clear();
            (None, new_bytes)
        } else {
            let mut combined = std::mem::take(remainder);
            combined.extend_from_slice(new_bytes);
            (Some(combined), &[])
        }
    };
    let input = owned.as_deref().unwrap_or(bytes);

    // Decode loop: consume all valid UTF-8 and any genuinely invalid bytes,
    // only leaving a trailing incomplete sequence in remainder.
    let mut pos = 0;
    loop {
        match std::str::from_utf8(&input[pos..]) {
            Ok(s) => {
                buffer.push_str(s);
                // Everything consumed – remainder stays empty.
                return;
            }
            Err(e) => {
                let valid_up_to = pos + e.valid_up_to();
                let valid_slice = &input[pos..valid_up_to];
                match std::str::from_utf8(valid_slice) {
                    Ok(valid) => buffer.push_str(valid),
                    Err(_) => buffer.push_str(&String::from_utf8_lossy(valid_slice)),
                }
                if let Some(invalid_len) = e.error_len() {
                    // Genuinely invalid byte(s) – emit U+FFFD and continue.
                    buffer.push('\u{FFFD}');
                    pos = valid_up_to + invalid_len;
                } else {
                    // Incomplete trailing sequence – stash for next chunk.
                    *remainder = input[valid_up_to..].to_vec();
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        append_utf8_safe, strip_sse_field, BoundedSseFrames, SseBlocks, SseFrame, SseOrJsonFrames,
        SseOrJsonItem, TextSseFrames,
    };

    #[test]
    fn hybrid_reader_keeps_pretty_json_bounded_and_emits_only_at_eof() {
        let mut reader = SseOrJsonFrames::default();
        for bytes in [&b" \n\xEF"[..], &b"\xBB"[..], &b"\xBF{\"ok\":\n\n"[..]] {
            let mut input = bytes;
            assert!(reader.read(&mut input, false).is_none());
            assert!(input.is_empty());
        }
        let mut input = &b"true}"[..];
        assert!(
            matches!(reader.read(&mut input, true), Some(SseOrJsonItem::Json(body)) if body.as_ref() == b" \n\xEF\xBB\xBF{\"ok\":\n\ntrue}")
        );

        let mut oversized = SseOrJsonFrames::default();
        let bytes = vec![b'{'; super::MAX_SSE_FRAME_BYTES + 1];
        let mut input = bytes.as_slice();
        assert!(matches!(
            oversized.read(&mut input, false),
            Some(SseOrJsonItem::Oversized)
        ));
        assert_eq!(oversized.prefix.capacity(), 0);
        assert!(oversized.read(&mut input, false).is_none());
    }

    #[test]
    fn hybrid_reader_preserves_sse_frames_and_eof_residual() {
        let mut reader = SseOrJsonFrames::default();
        let mut input = &b"event: done\ndata: {}\n\ndata: final"[..];
        assert!(
            matches!(reader.read(&mut input, false), Some(SseOrJsonItem::Frame(frame)) if frame.ends_with(b"\n\n"))
        );
        assert_eq!(input, b"data: final");
        assert!(
            matches!(reader.read(&mut input, true), Some(SseOrJsonItem::Frame(frame)) if frame.as_ref() == b"data: final")
        );
        assert!(reader.read(&mut input, true).is_none());
    }

    #[test]
    fn bounded_sse_frames_discard_until_real_boundary_without_retaining_bytes() {
        let mut frames = BoundedSseFrames::new(10);
        let mut input = &b"1234567890"[..];
        assert!(frames.read(&mut input).is_none());
        assert_eq!(frames.pending.len(), 10);

        let oversized = [b'x'; 1024];
        let mut input = &oversized[..];
        assert!(matches!(frames.read(&mut input), Some(SseFrame::Oversized)));
        assert!(frames.read(&mut input).is_none());
        assert_eq!(frames.pending.capacity(), 0);

        // This apparent event is still part of the oversized frame.
        let mut input = &b"\ndata:fake\r\n\r"[..];
        assert!(frames.read(&mut input).is_none());
        assert_eq!(frames.pending.capacity(), 0);

        // Consume the rest of the split CRLF boundary, then a complete event
        // occupying exactly the configured limit (including the delimiter).
        let mut input = &b"\ndata:yes\n\n"[..];
        let Some(SseFrame::Complete(frame)) = frames.read(&mut input) else {
            panic!("expected the next complete event");
        };
        assert_eq!(frame.as_ref(), b"data:yes\n\n");
        assert!(input.is_empty());
    }

    #[test]
    fn delimiter_on_first_over_limit_byte_resumes_at_next_event() {
        let mut frames = BoundedSseFrames::new(6);
        let mut input = &b"abcde\n\na\n\n"[..];
        assert!(matches!(frames.read(&mut input), Some(SseFrame::Oversized)));
        let Some(SseFrame::Complete(frame)) = frames.read(&mut input) else {
            panic!("expected a frame after the completed oversized frame");
        };
        assert_eq!(frame.as_ref(), b"a\n\n");
    }

    #[test]
    fn bounded_sse_frames_scan_each_wire_byte_once_across_fragment_sizes() {
        for size in [32, 64 * 1024] {
            let oversized = "x".repeat(size + 20);
            let accepted = format!("data: {}\r\n\r\n", "y".repeat(size / 2));
            let wire = format!("{oversized}\r\n\r\n{accepted}");
            for chunk_size in [1, 63, 8192] {
                let mut reader = BoundedSseFrames::new(size + 10);
                let mut rejected = 0;
                let mut frames = Vec::new();
                for chunk in wire.as_bytes().chunks(chunk_size) {
                    let mut input = chunk;
                    while let Some(frame) = reader.read(&mut input) {
                        match frame {
                            SseFrame::Oversized => rejected += 1,
                            SseFrame::Complete(bytes) => frames.push(bytes),
                        }
                    }
                    assert!(input.is_empty());
                }
                assert_eq!(reader.scanned_bytes, wire.len());
                assert_eq!(rejected, 1);
                assert_eq!(frames, [bytes::Bytes::from(accepted.clone())]);
                assert!(reader.pending.is_empty());
            }
        }
    }

    #[test]
    fn strip_sse_field_accepts_optional_space() {
        assert_eq!(
            strip_sse_field("data: {\"ok\":true}", "data"),
            Some("{\"ok\":true}")
        );
        assert_eq!(
            strip_sse_field("data:{\"ok\":true}", "data"),
            Some("{\"ok\":true}")
        );
        assert_eq!(
            strip_sse_field("event: message_start", "event"),
            Some("message_start")
        );
        assert_eq!(
            strip_sse_field("event:message_start", "event"),
            Some("message_start")
        );
        assert_eq!(strip_sse_field("id:1", "data"), None);
        assert_eq!(strip_sse_field("data-id:1", "data"), None);
        assert_eq!(strip_sse_field("data", "data"), None);
        assert_eq!(strip_sse_field("data:", "data"), Some(""));
        assert_eq!(strip_sse_field("data:  fixture", "data"), Some(" fixture"));
    }

    #[test]
    fn text_sse_frames_keep_unconsumed_blocks_between_pushes() {
        let mut frames = TextSseFrames::default();
        frames.push(b"data: first\r\n\r\ndata: \xe2\x82\n\n");
        assert_eq!(frames.next_block().as_deref(), Some("data: first"));
        frames.push(b"data: third\r\n\r");
        assert_eq!(frames.next_block().as_deref(), Some("data: \u{fffd}"));
        assert!(frames.next_block().is_none());
        frames.push(b"\nrest\xf0\x9f");
        assert_eq!(frames.next_block().as_deref(), Some("data: third"));
        assert!(frames.next_block().is_none());
        assert_eq!(frames.tail(), "rest\u{fffd}");
    }

    #[test]
    fn text_sse_frames_scan_each_wire_byte_once_across_fragment_sizes() {
        let frame = "data: café";
        let tail = "data: unterminated";
        for (frame_count, large_frame_size) in [(2, 32), (10_000, 64 * 1024)] {
            let large_frame = format!("data: {}🙂", "x".repeat(large_frame_size));
            let mut wire = format!("{large_frame}\r\n\r\n");
            for index in 0..frame_count {
                wire.push_str(frame);
                wire.push_str(if index % 2 == 0 { "\n\n" } else { "\r\n\r\n" });
            }
            wire.push_str(tail);

            for chunk_size in [1, 63, wire.len()] {
                let mut reader = TextSseFrames::default();
                let mut seen = 0;
                for chunk in wire.as_bytes().chunks(chunk_size) {
                    reader.push(chunk);
                    while let Some(block) = reader.next_block() {
                        let expected = if seen == 0 {
                            large_frame.as_str()
                        } else {
                            frame
                        };
                        assert_eq!(block, expected);
                        seen += 1;
                    }
                    let scanned_bytes = reader.scanned_bytes;
                    for _ in 0..3 {
                        assert!(reader.next_block().is_none());
                    }
                    assert_eq!(reader.scanned_bytes, scanned_bytes);
                }
                assert_eq!(seen, frame_count + 1);
                assert_eq!(reader.scanned_bytes, wire.len());
                assert_eq!(reader.tail(), tail);
            }
        }
    }

    #[test]
    fn complete_sse_blocks_scan_each_frame_once() {
        let frame = "data: café";
        let tail = "data: unterminated";
        for frame_count in [2, 10_000] {
            let mut body = String::new();
            for index in 0..frame_count {
                body.push_str(frame);
                body.push_str(if index % 2 == 0 { "\n\n" } else { "\r\n\r\n" });
            }
            body.push_str(tail);
            let mut blocks = SseBlocks::new(&body);
            for _ in 0..frame_count {
                assert_eq!(blocks.next(), Some(frame));
            }
            for _ in 0..3 {
                assert_eq!(blocks.next(), None);
                assert_eq!(blocks.remaining(), tail);
                assert_eq!(
                    blocks.scanned_bytes,
                    frame_count * (frame.len() + 1) + tail.len()
                );
            }
        }
    }

    // ------------------------------------------------------------------
    // append_utf8_safe tests
    // ------------------------------------------------------------------

    #[test]
    fn ascii_passthrough() {
        let mut buf = String::new();
        let mut rem = Vec::new();
        append_utf8_safe(&mut buf, &mut rem, b"hello world");
        assert_eq!(buf, "hello world");
        assert!(rem.is_empty());
    }

    #[test]
    fn complete_multibyte_in_single_chunk() {
        let mut buf = String::new();
        let mut rem = Vec::new();
        append_utf8_safe(&mut buf, &mut rem, "你好世界".as_bytes());
        assert_eq!(buf, "你好世界");
        assert!(rem.is_empty());
    }

    #[test]
    fn split_multibyte_across_two_chunks() {
        // "你" = E4 BD A0 (3 bytes)
        let bytes = "你".as_bytes();
        assert_eq!(bytes.len(), 3);

        let mut buf = String::new();
        let mut rem = Vec::new();

        // Chunk 1: first 2 bytes (incomplete)
        append_utf8_safe(&mut buf, &mut rem, &bytes[..2]);
        assert_eq!(buf, "");
        assert_eq!(rem.len(), 2);

        // Chunk 2: last byte completes the character
        append_utf8_safe(&mut buf, &mut rem, &bytes[2..]);
        assert_eq!(buf, "你");
        assert!(rem.is_empty());
    }

    #[test]
    fn split_four_byte_char_across_chunks() {
        // 😀 = F0 9F 98 80 (4 bytes)
        let bytes = "😀".as_bytes();
        assert_eq!(bytes.len(), 4);

        let mut buf = String::new();
        let mut rem = Vec::new();

        // Send 1 byte at a time
        append_utf8_safe(&mut buf, &mut rem, &bytes[..1]);
        assert_eq!(buf, "");
        assert_eq!(rem.len(), 1);

        append_utf8_safe(&mut buf, &mut rem, &bytes[1..2]);
        assert_eq!(buf, "");
        assert_eq!(rem.len(), 2);

        append_utf8_safe(&mut buf, &mut rem, &bytes[2..3]);
        assert_eq!(buf, "");
        assert_eq!(rem.len(), 3);

        append_utf8_safe(&mut buf, &mut rem, &bytes[3..]);
        assert_eq!(buf, "😀");
        assert!(rem.is_empty());
    }

    #[test]
    fn mixed_ascii_and_split_multibyte() {
        // "hi你" = 68 69 E4 BD A0
        let all = "hi你".as_bytes();
        assert_eq!(all.len(), 5);

        let mut buf = String::new();
        let mut rem = Vec::new();

        // Chunk 1: "hi" + first byte of "你"
        append_utf8_safe(&mut buf, &mut rem, &all[..3]);
        assert_eq!(buf, "hi");
        assert_eq!(rem.len(), 1);

        // Chunk 2: remaining 2 bytes of "你"
        append_utf8_safe(&mut buf, &mut rem, &all[3..]);
        assert_eq!(buf, "hi你");
        assert!(rem.is_empty());
    }

    #[test]
    fn multiple_split_characters_in_sequence() {
        let text = "你好";
        let bytes = text.as_bytes(); // E4 BD A0 E5 A5 BD

        let mut buf = String::new();
        let mut rem = Vec::new();

        // Split in the middle: first char complete + 1 byte of second
        append_utf8_safe(&mut buf, &mut rem, &bytes[..4]);
        assert_eq!(buf, "你");
        assert_eq!(rem.len(), 1);

        // Remaining 2 bytes complete second char
        append_utf8_safe(&mut buf, &mut rem, &bytes[4..]);
        assert_eq!(buf, "你好");
        assert!(rem.is_empty());
    }

    #[test]
    fn empty_chunks_are_harmless() {
        let mut buf = String::new();
        let mut rem = Vec::new();

        append_utf8_safe(&mut buf, &mut rem, b"");
        assert_eq!(buf, "");
        assert!(rem.is_empty());

        append_utf8_safe(&mut buf, &mut rem, b"ok");
        assert_eq!(buf, "ok");

        append_utf8_safe(&mut buf, &mut rem, b"");
        assert_eq!(buf, "ok");
    }

    #[test]
    fn sse_json_with_chinese_split_at_boundary() {
        // Simulates an SSE data line with Chinese content split across chunks
        let json_line = "data: {\"text\":\"你好\"}\n\n";
        let bytes = json_line.as_bytes();

        // Find where "你" starts in the byte stream and split there
        let ni_start = bytes.windows(3).position(|w| w == "你".as_bytes()).unwrap();
        let split_point = ni_start + 1; // split inside "你"

        let mut buf = String::new();
        let mut rem = Vec::new();

        append_utf8_safe(&mut buf, &mut rem, &bytes[..split_point]);
        append_utf8_safe(&mut buf, &mut rem, &bytes[split_point..]);

        assert_eq!(buf, json_line);
        assert!(rem.is_empty());

        // Verify the buffer can be parsed as SSE with valid JSON
        let data = strip_sse_field(buf.lines().next().unwrap(), "data").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(data).unwrap();
        assert_eq!(parsed["text"], "你好");
    }

    #[test]
    fn invalid_bytes_flushed_immediately_not_accumulated() {
        // 0xFF is never valid in UTF-8 – it should be replaced immediately,
        // not stashed in remainder.
        let mut buf = String::new();
        let mut rem = Vec::new();

        // "hi" + invalid byte + "ok"
        append_utf8_safe(&mut buf, &mut rem, b"hi\xFFok");
        assert!(
            rem.is_empty(),
            "remainder should be empty after invalid byte"
        );
        assert!(buf.contains("hi"), "valid prefix must be present");
        assert!(buf.contains("ok"), "valid suffix must be present");
        assert!(buf.contains('\u{FFFD}'), "invalid byte must produce U+FFFD");
    }

    #[test]
    fn invalid_byte_in_slow_path_flushed_immediately() {
        let mut buf = String::new();
        let mut rem = Vec::new();

        // Prime remainder with an incomplete sequence (first byte of "你")
        append_utf8_safe(&mut buf, &mut rem, &"你".as_bytes()[..1]);
        assert_eq!(rem.len(), 1);

        // Next chunk starts with an invalid byte – the stale remainder and the
        // invalid byte should both be flushed, not accumulated.
        append_utf8_safe(&mut buf, &mut rem, b"\xFFworld");
        assert!(rem.is_empty(), "remainder should be empty");
        assert!(
            buf.contains("world"),
            "valid data after invalid byte must appear"
        );
    }

    #[test]
    fn defensive_guard_flushes_oversized_remainder() {
        let mut buf = String::new();
        let mut rem = Vec::new();

        // Manually inject 4 invalid bytes into remainder to trigger the >3 guard.
        // This can't happen with well-formed UTF-8, but tests the safety net.
        rem.extend_from_slice(b"\x80\x80\x80\x80");
        assert_eq!(rem.len(), 4);

        append_utf8_safe(&mut buf, &mut rem, b"hello");
        // The 4 invalid bytes should have been flushed lossy, then "hello" decoded.
        assert!(rem.is_empty(), "remainder must be empty after guard flush");
        assert!(
            buf.contains("hello"),
            "valid data after guard flush must appear"
        );
        // The 4 invalid bytes each produce a U+FFFD
        let replacement_count = buf.chars().filter(|&c| c == '\u{FFFD}').count();
        assert_eq!(
            replacement_count, 4,
            "each invalid byte should produce one U+FFFD"
        );
    }
}
