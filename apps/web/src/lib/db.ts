import pg from "pg";

const globalForPg = globalThis as unknown as { pgPool?: pg.Pool };

export function getPool(): pg.Pool {
  if (!globalForPg.pgPool) {
    globalForPg.pgPool = new pg.Pool({
      connectionString:
        process.env.DATABASE_URL ??
        "postgresql://aibde:aibde@localhost:5432/aibde",
    });
  }
  return globalForPg.pgPool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}
