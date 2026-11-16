/**
 * Code Map: `parseSseStream(response)` — a minimal SSE frame reader for the
 * turn-scoped `POST /api/chat/messages` channel (AC6). Reads `response.body`
 * as raw bytes, buffers partial chunks across network reads, and yields one
 * `{ event, data }` record per blank-line-delimited SSE frame. Only
 * `event:`/`data:` fields are parsed (no `id:`/`retry:`) — this story's wire
 * format never uses them.
 */
export interface SseFrame {
  event: string;
  data: string;
}

function parseFrame(raw: string): SseFrame | undefined {
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }

  // A frame with no `data:` line carries nothing the two routes this parses
  // (`progress`/`result`) ever need — skipped rather than yielded empty.
  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join('\n') };
}

export async function* parseSseStream(response: Response): AsyncGenerator<SseFrame> {
  const body = response.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex !== -1) {
        const rawFrame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const frame = parseFrame(rawFrame);
        if (frame) yield frame;
        separatorIndex = buffer.indexOf('\n\n');
      }
    }

    // Flush any pending partial multi-byte UTF-8 sequence the decoder is
    // holding back (`{ stream: true }` above defers it across reads) —
    // without this, a reply ending mid-character right at a chunk boundary
    // would silently drop those trailing bytes.
    buffer += decoder.decode();

    const trailing = buffer.trim();
    if (trailing) {
      const frame = parseFrame(trailing);
      if (frame) yield frame;
    }
  } finally {
    reader.releaseLock();
  }
}
