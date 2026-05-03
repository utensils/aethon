//! Capped byte ring with a monotonic write cursor.
//!
//! Drops oldest bytes on overflow, but `total_appended` keeps growing
//! forever so callers can use it as a stable cursor for incremental
//! reads ("give me bytes since N"). Forward paging — see
//! [`Scrollback::read_from`] for the cold-start vs. resume contract.
//!
//! Cursor math is in *byte* units (not codepoints) because the PTY
//! reader appends raw bytes pre-lossy-decode. The bridge offers the
//! same byte cursor to the agent so resumes are stable across runs.

use std::collections::VecDeque;

/// Capped byte ring with a monotonic write cursor. The ring drops oldest
/// bytes on overflow; `total_appended` keeps growing forever so callers
/// can use it as a stable cursor for incremental reads ("give me bytes
/// since N"). `oldest_total` is the smallest cursor still in the ring —
/// reads with a cursor below that get clamped up to it.
#[derive(Debug)]
pub struct Scrollback {
    bytes: VecDeque<u8>,
    cap: usize,
    total_appended: u64,
}

impl Scrollback {
    pub fn new(cap: usize) -> Self {
        Self {
            bytes: VecDeque::with_capacity(cap.min(64 * 1024)),
            cap,
            total_appended: 0,
        }
    }
    pub fn append(&mut self, chunk: &[u8]) {
        self.bytes.extend(chunk.iter().copied());
        self.total_appended = self.total_appended.saturating_add(chunk.len() as u64);
        // Drop oldest bytes until back under cap. `drain` on VecDeque is
        // O(n) but the cap is fixed so overflow drops are bounded per
        // append — the worst case is the first chunk after the ring
        // reaches cap, after which every subsequent chunk drops a
        // chunk-sized slice.
        if self.bytes.len() > self.cap {
            let drop = self.bytes.len() - self.cap;
            self.bytes.drain(..drop);
        }
    }
    /// Smallest cursor still in the ring. Equal to
    /// `total_appended - bytes.len()`.
    pub fn oldest_total(&self) -> u64 {
        self.total_appended - self.bytes.len() as u64
    }
    pub fn total_appended(&self) -> u64 {
        self.total_appended
    }
    /// Forward-page from `since_total`: returns up to `max_bytes` bytes
    /// starting at that cursor, plus the cursor of the slice's first
    /// byte. Caller advances the cursor as `slice_total + content.len()`.
    /// `since_total` below the live oldest is clamped up.
    ///
    /// Note: this is a *forward* read. To get the most recent N bytes
    /// (cold-start "show me what's on screen"), pass
    /// `since_total = total_appended - N` clamped to the privacy floor —
    /// the call site in `shell_read_scrollback` does exactly that.
    /// A previous version always returned the tail of `max_bytes` from
    /// the after-skip window, which made paging skip bytes (codex P2):
    /// `read(since=0, max=4)` on a 12-byte buffer returned the last 4
    /// bytes and reported `total=8`, so the next cursor jumped past
    /// bytes 0..8 forever.
    pub fn read_from(&mut self, since_total: u64, max_bytes: usize) -> (Vec<u8>, u64) {
        let oldest = self.oldest_total();
        let from_total = since_total.max(oldest);
        let skip = (from_total - oldest) as usize;
        if skip >= self.bytes.len() {
            return (Vec::new(), self.total_appended);
        }
        let after_skip = self.bytes.len() - skip;
        let take = after_skip.min(max_bytes);
        let contig = self.bytes.make_contiguous();
        (contig[skip..skip + take].to_vec(), from_total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrollback_append_advances_total() {
        let mut sb = Scrollback::new(1024);
        sb.append(b"hello");
        sb.append(b" world");
        assert_eq!(sb.total_appended(), 11);
        assert_eq!(sb.oldest_total(), 0);
    }

    #[test]
    fn scrollback_drops_oldest_on_overflow() {
        let mut sb = Scrollback::new(8);
        sb.append(b"abcdefgh");
        assert_eq!(sb.total_appended(), 8);
        assert_eq!(sb.oldest_total(), 0);
        sb.append(b"IJ");
        assert_eq!(sb.total_appended(), 10);
        assert_eq!(sb.oldest_total(), 2);
        let (got, slice_total) = sb.read_from(0, 16);
        assert_eq!(got, b"cdefghIJ");
        assert_eq!(slice_total, 2);
    }

    #[test]
    fn scrollback_read_from_clamps_below_oldest() {
        let mut sb = Scrollback::new(4);
        sb.append(b"WXYZ1234"); // oldest=4, total=8
        let (got, slice_total) = sb.read_from(0, 16);
        assert_eq!(got, b"1234");
        assert_eq!(slice_total, 4);
    }

    #[test]
    fn scrollback_read_from_returns_forward_window_not_tail() {
        // Codex P2 regression: the previous read_since returned the
        // *tail* of max_bytes regardless of the cursor, so paging from 0
        // skipped the head. Verify forward semantics: read(since=0,max=4)
        // on "0123456789" returns the head, not the tail.
        let mut sb = Scrollback::new(64);
        sb.append(b"0123456789");
        let (got, slice_total) = sb.read_from(0, 4);
        assert_eq!(got, b"0123");
        assert_eq!(slice_total, 0);
    }

    #[test]
    fn scrollback_read_from_at_or_past_total_is_empty() {
        let mut sb = Scrollback::new(64);
        sb.append(b"hi");
        let (got, slice_total) = sb.read_from(2, 16);
        assert!(got.is_empty());
        assert_eq!(slice_total, 2);
        let (got, _) = sb.read_from(99, 16);
        assert!(got.is_empty());
    }

    #[test]
    fn scrollback_incremental_cursor_walks_full_stream() {
        let mut sb = Scrollback::new(64);
        sb.append(b"hello ");
        sb.append(b"world!");
        // Drain incrementally with a tiny budget per call. With forward
        // paging, every byte is observed exactly once.
        let mut cursor = 0u64;
        let mut acc: Vec<u8> = Vec::new();
        for _ in 0..10 {
            let (got, slice_total) = sb.read_from(cursor, 4);
            if got.is_empty() {
                break;
            }
            assert_eq!(
                slice_total, cursor,
                "slice_total must equal cursor (forward paging)"
            );
            acc.extend_from_slice(&got);
            cursor = slice_total + got.len() as u64;
        }
        assert_eq!(&acc[..], b"hello world!");
    }

    #[test]
    fn scrollback_floor_blocks_pre_consent_bytes() {
        // End-to-end of the privacy contract: bytes appended *before* the
        // floor must never appear in a read snapshot, even if since_total
        // is 0 / unset.
        let mut sb = Scrollback::new(64);
        sb.append(b"SECRET-");
        let floor = sb.total_appended();
        sb.append(b"public");
        let cursor = floor; // caller would pass since_total=floor
        let (got, slice_total) = sb.read_from(cursor, 16);
        assert_eq!(got, b"public");
        assert_eq!(slice_total, floor);
    }

    #[test]
    fn scrollback_paging_no_cursor_then_resume() {
        // Mimics the cold-start use case: caller passes no cursor, gets
        // the latest `max_bytes`, then pages forward from the returned
        // cursor. This is the exact pattern shell_read_scrollback uses
        // when args.since_total is None.
        let mut sb = Scrollback::new(64);
        sb.append(b"hello world!");
        let max_bytes = 4usize;
        // Cold start cursor = total - max_bytes (clamped to oldest).
        let total = sb.total_appended();
        let cold_cursor = total
            .saturating_sub(max_bytes as u64)
            .max(sb.oldest_total());
        let (got, slice_total) = sb.read_from(cold_cursor, max_bytes);
        assert_eq!(got, b"rld!");
        assert_eq!(slice_total, 8);
        // Resume from after the returned slice — should be empty (caught up).
        let (got, _) = sb.read_from(slice_total + got.len() as u64, max_bytes);
        assert!(got.is_empty());
    }
}
