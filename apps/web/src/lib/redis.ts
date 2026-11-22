import { redisKeys } from "@ai-bde/orchestrator";
import { Redis } from "ioredis";

const globalForRedis = globalThis as unknown as { aibdeRedis?: Redis | null };

/** Shared Redis client; null when REDIS_URL is unset (Postgres schedule remains SoR). */
export function getRedis(): Redis | null {
  if (globalForRedis.aibdeRedis !== undefined) {
    return globalForRedis.aibdeRedis;
  }
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    globalForRedis.aibdeRedis = null;
    return null;
  }
  globalForRedis.aibdeRedis = new Redis(url, {
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  });
  return globalForRedis.aibdeRedis;
}

async function ensureConnected(redis: Redis): Promise<boolean> {
  try {
    if (redis.status === "wait") await redis.connect();
    return true;
  } catch (err) {
    console.error("[redis] connect failed", err);
    return false;
  }
}

/** ZADD seq:due score=unix_ms member=outreach_item_id */
export async function enqueueSeqDue(
  outreachItemId: string,
  scheduledAt: Date,
): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  if (!(await ensureConnected(redis))) return false;
  await redis.zadd(
    redisKeys.seqDue,
    scheduledAt.getTime(),
    outreachItemId,
  );
  return true;
}

/** Remove one or many outreach item ids from seq:due */
export async function removeSeqDue(
  outreachItemIds: string[],
): Promise<boolean> {
  if (!outreachItemIds.length) return true;
  const redis = getRedis();
  if (!redis) return false;
  if (!(await ensureConnected(redis))) return false;
  await redis.zrem(redisKeys.seqDue, ...outreachItemIds);
  return true;
}

/** Remove all due members for outreach items belonging to a lead (caller supplies ids). */
export async function clearLeadSeqDue(outreachItemIds: string[]): Promise<void> {
  await removeSeqDue(outreachItemIds);
}
