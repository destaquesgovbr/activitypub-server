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

/** Troca o pool (testes de integração). `null` volta a criar pelo env na próxima chamada. */
export function setGovbrNewsPool(p: postgres.Sql | null): void {
	pool = p;
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
	/** Código do L1 canônico (`news.theme_l1_id`), o mesmo que portal e Typesense mostram. */
	theme_l1_code: string | null;
}

export async function fetchArticle(uniqueId: string): Promise<GovbrNewsArticle | null> {
	const sql = getGovbrNewsPool();
	const rows = await sql<GovbrNewsArticle[]>`
		SELECT n.unique_id, n.title, n.content, n.url, n.image_url,
		       n.tags, n.published_at, n.agency_key,
		       t1.code AS theme_l1_code
		FROM news n
		LEFT JOIN themes t1 ON t1.id = n.theme_l1_id
		WHERE n.unique_id = ${uniqueId}
	`;
	return rows[0] ?? null;
}
