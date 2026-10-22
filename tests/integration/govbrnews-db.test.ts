import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fetchArticle, setGovbrNewsPool } from "../../src/govbrnews-db.js";
import { getSql, setupTestDatabase, teardownTestDatabase } from "../helpers/db.js";

/**
 * fetchArticle contra um Postgres real, com o recorte de `news`/`themes` do
 * govbrnews que a query usa (mesmos tipos de produção).
 */
describe("fetchArticle (govbrnews)", () => {
	beforeAll(async () => {
		const { sql } = await setupTestDatabase();
		await sql`
			CREATE TABLE themes (
				id SERIAL PRIMARY KEY,
				code VARCHAR(20) NOT NULL UNIQUE,
				label VARCHAR(255) NOT NULL,
				level SMALLINT NOT NULL
			)
		`;
		await sql`
			CREATE TABLE news (
				unique_id VARCHAR(32) PRIMARY KEY,
				theme_l1_id INTEGER REFERENCES themes(id),
				most_specific_theme_id INTEGER REFERENCES themes(id),
				title TEXT NOT NULL,
				url TEXT,
				image_url TEXT,
				tags TEXT[],
				content TEXT,
				published_at TIMESTAMPTZ,
				agency_key VARCHAR(100)
			)
		`;
		await sql`
			INSERT INTO themes (code, label, level) VALUES
				('15', 'Direitos Humanos e Cidadania', 1),
				('24', 'Minorias e Grupos Especiais', 1),
				('24.01', 'Povos Indígenas', 2)
		`;
		setGovbrNewsPool(sql);
	});

	afterEach(async () => {
		await getSql()`TRUNCATE news`;
	});

	afterAll(async () => {
		setGovbrNewsPool(null);
		const sql = getSql();
		await sql`DROP TABLE IF EXISTS news`;
		await sql`DROP TABLE IF EXISTS themes`;
		await teardownTestDatabase();
	});

	async function insertNews(
		uniqueId: string,
		l1Code: string | null,
		mostSpecificCode: string | null,
	) {
		const sql = getSql();
		await sql`
			INSERT INTO news (unique_id, theme_l1_id, most_specific_theme_id, title, url, tags, content, published_at, agency_key)
			VALUES (
				${uniqueId},
				(SELECT id FROM themes WHERE code = ${l1Code}),
				(SELECT id FROM themes WHERE code = ${mostSpecificCode}),
				'Título', 'https://www.gov.br/mdh/noticia', ${["tag"]}, '<p>Texto</p>',
				'2026-10-20T12:00:00Z', 'mdh'
			)
		`;
	}

	it("returns the canonical L1 code of news.theme_l1_id, even when the most specific has another prefix", async () => {
		await insertNews("divergente", "15", "24.01");

		const article = await fetchArticle("divergente");

		expect(article).toMatchObject({
			unique_id: "divergente",
			title: "Título",
			url: "https://www.gov.br/mdh/noticia",
			tags: ["tag"],
			agency_key: "mdh",
			theme_l1_code: "15",
		});
		expect(article?.published_at?.toISOString()).toBe("2026-10-20T12:00:00.000Z");
	});

	it("returns theme_l1_code null for an article without L1", async () => {
		await insertNews("sem-tema", null, null);

		const article = await fetchArticle("sem-tema");

		expect(article?.unique_id).toBe("sem-tema");
		expect(article?.theme_l1_code).toBeNull();
	});

	it("returns null for an unknown article", async () => {
		expect(await fetchArticle("nao-existe")).toBeNull();
	});
});
