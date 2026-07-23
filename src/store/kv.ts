/**
 * Durable key-value store for domain data.
 *
 * Uses the toolkit's Redis-backed adapter when REDIS_URL is set (production),
 * otherwise MemorySessionStorage (dev / test harness). Never scan the keyspace —
 * callers maintain explicit index records.
 */

import type { StorageAdapter } from "grammy";
import {
  MemorySessionStorage,
  RedisSessionStorage,
  type RedisLike,
} from "../toolkit/index.js";

const PREFIX = "cc:"; // CourseConnect domain namespace

type Json = unknown;

let adapter: StorageAdapter<Json> | null = null;
let memoryFallback: MemorySessionStorage<Json> | null = null;

function getAdapter(): StorageAdapter<Json> {
  if (adapter) return adapter;

  const url =
    typeof process !== "undefined" ? process.env.REDIS_URL : undefined;

  if (url) {
    // Lazy ioredis — same pattern as toolkit (Workers-safe: no static node: import).
    let inner: Promise<RedisSessionStorage<Json>> | null = null;
    const get = (): Promise<RedisSessionStorage<Json>> =>
      (inner ??= (async () => {
        const { createRequire } = await import("node:module");
        const require = createRequire(import.meta.url);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ioredis: any = require("ioredis");
        const Redis = ioredis.default ?? ioredis.Redis ?? ioredis;
        const client = new Redis(url, {
          maxRetriesPerRequest: null,
          lazyConnect: false,
        }) as RedisLike;
        return new RedisSessionStorage<Json>(client, PREFIX);
      })());
    adapter = {
      read: async (key) => (await get()).read(key),
      write: async (key, value) => {
        await (await get()).write(key, value);
      },
      delete: async (key) => {
        await (await get()).delete(key);
      },
    };
    return adapter;
  }

  memoryFallback = new MemorySessionStorage<Json>();
  adapter = memoryFallback;
  return adapter;
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const v = await getAdapter().read(key);
  return v as T | undefined;
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  await getAdapter().write(key, value as Json);
}

export async function kvDel(key: string): Promise<void> {
  await getAdapter().delete(key);
}

/**
 * Reset in-memory durable data. Used by the test harness between specs so
 * catalogs don't leak across cases. No-op when Redis is the backing store.
 */
export function resetDurableStore(): void {
  if (memoryFallback) {
    for (const k of memoryFallback.readAllKeys()) {
      memoryFallback.delete(k);
    }
  }
  // Drop adapter so the next getAdapter() rebuilds a clean MemorySessionStorage
  // when not on Redis (keeps tests hermetic).
  if (!process.env.REDIS_URL) {
    adapter = null;
    memoryFallback = null;
  }
}
