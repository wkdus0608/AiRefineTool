import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
const poolMax = Number(process.env.DATABASE_POOL_MAX || 3);

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to start the Supereasy server.");
}

export const pool = new Pool({
  connectionString: databaseUrl,
  max: poolMax,
  ssl:
    process.env.DATABASE_SSL === "true"
      ? {
          rejectUnauthorized: false,
        }
      : undefined,
});

export async function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(callback) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
