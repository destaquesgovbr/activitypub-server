/**
 * Migration: add news_payload JSONB column to ap_publish_queue.
 *
 * Usage: DATABASE_URL=postgres://... tsx scripts/migrate-add-payload.ts
 *
 * Idempotent: checks if column exists before adding.
 */

import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error("DATABASE_URL is required");
	process.exit(1);
}

const sql = postgres(databaseUrl);

async function migrate() {
	const [exists] = await sql`
		SELECT 1 FROM information_schema.columns
		WHERE table_name = 'ap_publish_queue' AND column_name = 'news_payload'
	`;

	if (exists) {
		console.log("Column news_payload already exists — nothing to do.");
	} else {
		await sql`ALTER TABLE ap_publish_queue ADD COLUMN news_payload JSONB`;
		console.log("Added news_payload JSONB column to ap_publish_queue.");
	}

	await sql.end();
}

migrate().catch((err) => {
	console.error("Migration failed:", err);
	process.exit(1);
});
