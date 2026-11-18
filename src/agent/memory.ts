import { PostgresStore } from '@langchain/langgraph-checkpoint-postgres/store';
import { Mistral } from '@mistralai/mistralai';
import type { Env } from '../config/env.js';

/**
 * Intent: "embedding with Mistral `mistral-embed` (existing
 * `MISTRAL_API_KEY`)". Same official SDK `moderation.ts`'s own
 * `defaultClassify` already uses for Mistral Moderation 2 — no new client
 * library.
 */
export const MISTRAL_EMBEDDING_MODEL = 'mistral-embed';

/** Code Map: "`PostgresStore.fromConnString` (Mistral embeddings adapter,
 * dims 1024, cosine)" — `mistral-embed`'s default output dimension. */
const EMBEDDING_DIMS = 1024;

/** Boundary: "Memory is strictly per-user (namespace `['memory', userId]`);
 * never cross-user." */
const MEMORY_NAMESPACE_ROOT = 'memory';

/** I/O matrix: "retrieve the user's top-3 memories above a similarity
 * floor, capped in characters". `mode: 'auto'` + a `query` + this store's
 * own `index` config resolves to a cosine vector search (`PostgresStore`'s
 * own `search()` — see its dist `index.js`), so no explicit `mode` is
 * needed at the call site below. */
const RECALL_TOP_K = 3;

/** Cosine similarity floor (`1 - cosine distance`, so higher is closer) —
 * conservative enough that an unrelated topic's cheapest/most-recent
 * memory doesn't get folded into every unrelated turn's prompt. */
const SIMILARITY_FLOOR = 0.5;

/** Char budget across all memories folded into the system prompt — keeps a
 * verbose stored comment (or several) from ballooning every turn's prompt
 * size. */
const MAX_RECALLED_CHARS = 600;

/**
 * Code Map: "Mistral embeddings adapter". `PostgresStore`'s own
 * `IndexConfig.embed` accepts a plain `(texts: string[]) => Promise<number[][]>`
 * function directly (its `vector-operations.ts` checks `typeof embed ===
 * 'function'` first, before trying `Embeddings`-shaped objects) — so this
 * stays a single function, not a class implementing a wider interface.
 */
function createMistralEmbedFn(env: Pick<Env, 'MISTRAL_API_KEY'>): (texts: string[]) => Promise<number[][]> {
  const client = new Mistral({ apiKey: env.MISTRAL_API_KEY });
  return async (texts: string[]): Promise<number[][]> => {
    const response = await client.embeddings.create({ model: MISTRAL_EMBEDDING_MODEL, inputs: texts });
    return response.data.map((item) => item.embedding ?? []);
  };
}

/**
 * Code Map: "`createMemoryStore(env)` returns configured
 * `PostgresStore.fromConnString`". Pure construction only (same
 * `checkpointer.ts` precedent this file's own header comment reuses) —
 * `.setup()` (which runs `CREATE EXTENSION vector` and the store's own
 * migrations) is called once at startup in `src/api/index.ts`, not here.
 */
export function createMemoryStore(env: Pick<Env, 'DATABASE_URL' | 'MISTRAL_API_KEY'>): PostgresStore {
  return PostgresStore.fromConnString(env.DATABASE_URL, {
    index: {
      dims: EMBEDDING_DIMS,
      embed: createMistralEmbedFn(env),
      distanceMetric: 'cosine',
    },
  });
}

function memoryNamespace(userId: string): string[] {
  return [MEMORY_NAMESPACE_ROOT, userId];
}

/** Narrow seams `memory.ts`'s own helpers depend on — lets a test pass an
 * in-memory fake instead of a real `PostgresStore`/Postgres connection. */
export type MemoryPutStore = Pick<PostgresStore, 'put'>;
export type MemoryDeleteStore = Pick<PostgresStore, 'delete'>;
export type MemorySearchStore = Pick<PostgresStore, 'search'>;

export interface RememberFeedbackParams {
  userId: string;
  /** The rated message's id — reused as the memory item's key, so the same
   * message's memory entry can be updated/deleted later by that same id
   * (I/O matrix: "Rating changed/removed ... memory entry updated /
   * deleted to match"). */
  messageId: string;
  /** Design Notes: "the embedded/dataset text is always the already-
   * moderated comment" — never raw user input (Boundary). */
  comment: string;
}

/**
 * Boundary: "Memory/dataset writes never fail or block the feedback HTTP
 * response (catch + log)." Upserts (same key = same message overwrites the
 * same item, no duplicate memory per message).
 */
export async function rememberFeedback(store: MemoryPutStore, params: RememberFeedbackParams): Promise<void> {
  try {
    await store.put(memoryNamespace(params.userId), params.messageId, { comment: params.comment }, ['comment']);
  } catch (error) {
    console.error('[memory] rememberFeedback failed:', { userId: params.userId, error: (error as Error)?.message });
  }
}

/** I/O matrix: "Rating changed/removed ... memory entry updated / deleted
 * to match". Never throws (Boundary) — a no-op when no entry exists for
 * this message, same "harmless no-op" precedent as `record_feedback.ts`'s
 * own `removeFeedback`. */
export async function forgetFeedback(store: MemoryDeleteStore, userId: string, messageId: string): Promise<void> {
  try {
    await store.delete(memoryNamespace(userId), messageId);
  } catch (error) {
    console.error('[memory] forgetFeedback failed:', { userId, error: (error as Error)?.message });
  }
}

/**
 * Code Map: "top 3, similarity floor, char cap". Boundary: "Retrieval
 * failure never blocks a turn — proceeds with the base prompt" (returns
 * `[]` on any error, logged, never thrown). Strictly scoped to this one
 * user's namespace — never searches across users (Boundary).
 */
export async function recallMemories(store: MemorySearchStore, userId: string, query: string): Promise<string[]> {
  if (!query.trim()) return [];

  try {
    const results = await store.search(memoryNamespace(userId), {
      query,
      limit: RECALL_TOP_K,
      similarityThreshold: SIMILARITY_FLOOR,
    });

    const memories: string[] = [];
    let totalChars = 0;
    for (const item of results) {
      const comment = item.value?.comment;
      if (typeof comment !== 'string' || !comment) continue;
      if (totalChars + comment.length > MAX_RECALLED_CHARS) break;
      memories.push(comment);
      totalChars += comment.length;
    }
    return memories;
  } catch (error) {
    console.error('[memory] recallMemories failed:', { userId, error: (error as Error)?.message });
    return [];
  }
}
