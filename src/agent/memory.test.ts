import { describe, expect, it, vi } from 'vitest';
import { rememberFeedback, forgetFeedback, recallMemories } from './memory.js';

// Story 5.3b (AD-2) I/O matrix: "Rating + comment stored -> memory upserted
// (user-scoped)" — the namespace is strictly `['memory', userId]` (Boundary:
// "never cross-user"), the key is the message id (so a later change/remove
// can address the same entry), and only the comment field is indexed for
// embedding (never the whole value object).
describe('rememberFeedback', () => {
  it('upserts the comment into the user-scoped namespace, keyed by message id', async () => {
    const put = vi.fn().mockResolvedValue(undefined);

    await rememberFeedback({ put }, { userId: 'user-1', messageId: 'msg-1', comment: 'This really helped' });

    expect(put).toHaveBeenCalledWith(['memory', 'user-1'], 'msg-1', { comment: 'This really helped' }, ['comment']);
  });
});

// I/O matrix: "Rating changed/removed -> memory entry ... deleted to match".
describe('forgetFeedback', () => {
  it('deletes the message entry from the user-scoped namespace', async () => {
    const del = vi.fn().mockResolvedValue(undefined);

    await forgetFeedback({ delete: del }, 'user-1', 'msg-1');

    expect(del).toHaveBeenCalledWith(['memory', 'user-1'], 'msg-1');
  });
});

// I/O matrix: "retrieve the user's top-3 memories above a similarity floor,
// capped in characters" — exercised directly against the already-ranked
// results `PostgresStore.search` would hand back, rather than a real
// vector search.
describe('recallMemories', () => {
  it('extracts each result\'s comment, scoped to this user\'s namespace, via a vector query', async () => {
    const search = vi.fn().mockResolvedValue([
      { namespace: ['memory', 'user-1'], key: 'a', value: { comment: 'Loved the budgeting tip' } },
      { namespace: ['memory', 'user-1'], key: 'b', value: { comment: 'Too generic, want specifics' } },
    ]);

    const memories = await recallMemories({ search }, 'user-1', 'budgeting advice');

    expect(search).toHaveBeenCalledWith(
      ['memory', 'user-1'],
      expect.objectContaining({ query: 'budgeting advice', limit: 3 }),
    );
    expect(memories).toEqual(['Loved the budgeting tip', 'Too generic, want specifics']);
  });

  it('stops adding memories once the character cap would be exceeded', async () => {
    const long = 'x'.repeat(400);
    const search = vi.fn().mockResolvedValue([
      { namespace: ['memory', 'user-1'], key: 'a', value: { comment: long } },
      { namespace: ['memory', 'user-1'], key: 'b', value: { comment: long } },
      { namespace: ['memory', 'user-1'], key: 'c', value: { comment: 'short one' } },
    ]);

    const memories = await recallMemories({ search }, 'user-1', 'topic');

    // The second 400-char item would push the running total past the cap,
    // so it (and the one after it) are dropped — never truncated mid-text.
    expect(memories).toEqual([long]);
  });

  // Boundary: "Retrieval failure never blocks a turn — proceeds with the
  // base prompt" / I/O matrix: "logged, never thrown to caller" — shared
  // failure-branch behavior across all three functions above.
  it.each([
    ['rememberFeedback', () => rememberFeedback({ put: vi.fn().mockRejectedValue(new Error('down')) }, { userId: 'u', messageId: 'm', comment: 'c' }), undefined],
    ['forgetFeedback', () => forgetFeedback({ delete: vi.fn().mockRejectedValue(new Error('down')) }, 'u', 'm'), undefined],
    ['recallMemories', () => recallMemories({ search: vi.fn().mockRejectedValue(new Error('down')) }, 'u', 'q'), []],
  ] as const)('%s never throws when the store call fails', async (_label, run, expected) => {
    await expect(run()).resolves.toEqual(expected);
  });
});
