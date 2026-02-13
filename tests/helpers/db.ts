import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

let container: { stop(): Promise<void> } | null = null;
let sql: postgres.Sql;
let setupCount = 0;

export async function setupTestDatabase() {
	setupCount++;
	if (sql) return { sql, connectionString: "" };

	const externalUrl = process.env.TEST_DATABASE_URL;

	if (externalUrl) {
		sql = postgres(externalUrl);
	} else {
		const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
		const started = await new PostgreSqlContainer("postgres:15")
			.withDatabase("federation_test")
			.start();
		container = started;
		sql = postgres(started.getConnectionUri());
	}

	const schema = readFileSync(join(import.meta.dirname, "../../sql/schema.sql"), "utf-8");
	await sql.unsafe(schema);

	return { sql, connectionString: "" };
}

export async function teardownTestDatabase() {
	setupCount--;
	if (setupCount > 0) return;
	if (sql) await sql.end();
	if (container) await container.stop();
}

export async function cleanTables() {
	await sql`TRUNCATE ap_publish_queue, ap_delivery_log, ap_activities, ap_followers, ap_dead_servers, ap_actors RESTART IDENTITY CASCADE`;
	await sql`DELETE FROM ap_sync_watermark WHERE id = 1`;
	await sql`INSERT INTO ap_sync_watermark (last_processed_at, last_run_at) VALUES (NOW(), NOW()) ON CONFLICT (id) DO NOTHING`;
}

export function getSql() {
	return sql;
}
