import postgres from "postgres";

let pool: postgres.Sql | null = null;

export function getGovbrNewsPool(): postgres.Sql {
	if (!pool) {
		const databaseUrl = process.env.GOVBRNEWS_DATABASE_URL;
		if (!databaseUrl) {
			throw new Error("GOVBRNEWS_DATABASE_URL environment variable is required");
		}
		pool = postgres(databaseUrl);
	}
	return pool;
}

export interface GovbrNewsArticle {
	unique_id: string;
	title: string;
	content: string;
	url: string;
	image_url: string | null;
	tags: string[] | null;
	published_at: Date | null;
	agency_key: string | null;
}

export async function fetchArticle(uniqueId: string): Promise<GovbrNewsArticle | null> {
	const sql = getGovbrNewsPool();
	const rows = await sql<GovbrNewsArticle[]>`
		SELECT n.unique_id, n.title, n.content, n.url, n.image_url,
		       n.tags, n.published_at, n.agency_key
		FROM news n
		WHERE n.unique_id = ${uniqueId}
	`;
	return rows[0] ?? null;
}
