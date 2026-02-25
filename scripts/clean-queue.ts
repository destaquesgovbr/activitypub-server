import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error("DATABASE_URL is required");
	process.exit(1);
}

const sql = postgres(databaseUrl);

async function clean() {
	const [before] = await sql`SELECT COUNT(*) as cnt FROM ap_publish_queue`;
	console.log(`Queue before: ${before.cnt} entries`);

	await sql`DELETE FROM ap_publish_queue`;
	await sql`DELETE FROM ap_sync_watermark`;

	console.log("Cleared ap_publish_queue and ap_sync_watermark.");
	await sql.end();
}

clean().catch((err) => {
	console.error("Clean failed:", err);
	process.exit(1);
});
