import { describe, expect, it } from 'vitest';
import { parseSseStream } from './sse.js';

function streamFromChunks(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body);
}

// AC6: progress events "arrive over one turn-scoped SSE connection" — this
// is the client-side parser `ChatThread.tsx` consumes that connection
// through. Table-driven over how the frame boundaries land relative to the
// underlying stream's chunk boundaries, since a real network read can split
// a frame anywhere.
describe('parseSseStream (AC6: SSE wire parsing)', () => {
  it.each([
    [
      'one frame per network chunk',
      ['event: progress\ndata: {"step":"checking_message"}\n\n', 'event: result\ndata: {"ok":true}\n\n'],
    ],
    [
      'a single frame split mid-line across chunks',
      ['event: progress\ndata: {"step":"check', 'ing_message"}\n\n', 'event: result\ndata: {"ok":true}\n\n'],
    ],
    ['both frames in one chunk', ['event: progress\ndata: {"step":"checking_message"}\n\nevent: result\ndata: {"ok":true}\n\n']],
  ] as const)('yields both frames in order regardless of chunking: %s', async (_label, chunks) => {
    const frames = [];
    for await (const frame of parseSseStream(streamFromChunks([...chunks]))) frames.push(frame);

    expect(frames).toEqual([
      { event: 'progress', data: '{"step":"checking_message"}' },
      { event: 'result', data: '{"ok":true}' },
    ]);
  });

  it('yields nothing for a response with no body', async () => {
    const frames = [];
    for await (const frame of parseSseStream(new Response(null))) frames.push(frame);

    expect(frames).toEqual([]);
  });
});
