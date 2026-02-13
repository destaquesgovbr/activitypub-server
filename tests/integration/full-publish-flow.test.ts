import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { NewsRow } from "../../src/article-builder.js";
import { setPool } from "../../src/db.js";
import { processPublishQueue } from "../../src/publisher.js";
import { cleanTables, getSql, setupTestDatabase, teardownTestDatabase } from "../helpers/db.js";
import { TEST_ACTORS } from "../helpers/fixtures.js";

describe("full publish flow (integration)", () => {
	beforeAll(async () => {
		const { sql } = await setupTestDatabase();
		setPool(sql);
	});

	afterEach(async () => {
		await cleanTables();
	});

	afterAll(async () => {
		await teardownTestDatabase();
	});

	async function seedActor(identifier: string) {
		const sql = getSql();
		const actor = TEST_ACTORS[identifier as keyof typeof TEST_ACTORS] ?? TEST_ACTORS.agricultura;
		const [row] = await sql`
			INSERT INTO ap_actors (identifier, actor_type, display_name, summary, rsa_public_key_jwk, rsa_private_key_jwk, ed25519_public_key_jwk, ed25519_private_key_jwk)
			VALUES (${actor.identifier}, ${actor.actor_type}, ${actor.display_name}, ${actor.summary}, ${sql.json(actor.rsa_public_key_jwk)}, ${sql.json(actor.rsa_private_key_jwk)}, ${sql.json(actor.ed25519_public_key_jwk)}, ${sql.json(actor.ed25519_private_key_jwk)})
			RETURNING id
		`;
		return row.id as number;
	}

	async function enqueueItem(newsUniqueId: string, actorIdentifier: string) {
		const sql = getSql();
		await sql`
			INSERT INTO ap_publish_queue (news_unique_id, actor_identifier)
			VALUES (${newsUniqueId}, ${actorIdentifier})
		`;
	}

	function makeMockFederation() {
		const sendActivity = vi.fn().mockResolvedValue(undefined);
		const ctx = { sendActivity };
		const federation = {
			createContext: vi.fn().mockReturnValue(ctx),
		} as never;
		return { federation, sendActivity };
	}

	function makeFetchNews(articles: Map<string, NewsRow>) {
		return async (uniqueId: string): Promise<NewsRow | null> => {
			return articles.get(uniqueId) ?? null;
		};
	}

	it("processes a single item end-to-end: pending → published", async () => {
		await seedActor("agricultura");
		await enqueueItem("news-001", "agricultura");

		const { federation, sendActivity } = makeMockFederation();
		const articles = new Map<string, NewsRow>([
			[
				"news-001",
				{
					unique_id: "news-001",
					title: "Safra recorde de soja",
					content_html: "<p>O Brasil bateu recorde na safra de soja.</p>",
					summary: "Produção de soja atinge novo patamar",
					image_url: "https://destaques.gov.br/images/soja.jpg",
					tags: ["agricultura", "soja"],
					published_at: new Date("2026-02-12T10:00:00Z"),
					canonical_url: "https://destaques.gov.br/artigos/news-001",
				},
			],
		]);

		const result = await processPublishQueue(federation, 100, makeFetchNews(articles));

		expect(result.processed).toBe(1);
		expect(result.published).toBe(1);
		expect(result.failed).toBe(0);
		expect(sendActivity).toHaveBeenCalledOnce();

		// Verify DB state
		const sql = getSql();
		const [row] =
			await sql`SELECT status, processed_at FROM ap_publish_queue WHERE news_unique_id = 'news-001'`;
		expect(row.status).toBe("published");
		expect(row.processed_at).not.toBeNull();
	});

	it("marks item as failed when actor does not exist in DB", async () => {
		await enqueueItem("news-002", "nonexistent-actor");

		const { federation } = makeMockFederation();
		const result = await processPublishQueue(federation, 100, makeFetchNews(new Map()));

		expect(result.processed).toBe(1);
		expect(result.failed).toBe(1);
		expect(result.published).toBe(0);

		const sql = getSql();
		const [row] =
			await sql`SELECT status, error_message FROM ap_publish_queue WHERE news_unique_id = 'news-002'`;
		expect(row.status).toBe("failed");
		expect(row.error_message).toContain("Actor not found");
	});

	it("marks item as failed when news article not found", async () => {
		await seedActor("agricultura");
		await enqueueItem("missing-news", "agricultura");

		const { federation } = makeMockFederation();
		const result = await processPublishQueue(federation, 100, makeFetchNews(new Map()));

		expect(result.failed).toBe(1);

		const sql = getSql();
		const [row] =
			await sql`SELECT status, error_message FROM ap_publish_queue WHERE news_unique_id = 'missing-news'`;
		expect(row.status).toBe("failed");
		expect(row.error_message).toContain("News article not found");
	});

	it("processes multiple items, some succeed and some fail", async () => {
		await seedActor("agricultura");
		await seedActor("portal");
		await enqueueItem("news-a", "agricultura");
		await enqueueItem("news-b", "portal");
		await enqueueItem("news-c", "nonexistent");

		const { federation, sendActivity } = makeMockFederation();
		const articles = new Map<string, NewsRow>([
			[
				"news-a",
				{
					unique_id: "news-a",
					title: "Artigo A",
					content_html: "<p>Conteúdo A</p>",
					summary: null,
					image_url: null,
					tags: [],
					published_at: new Date(),
					canonical_url: "https://destaques.gov.br/artigos/news-a",
				},
			],
			[
				"news-b",
				{
					unique_id: "news-b",
					title: "Artigo B",
					content_html: "<p>Conteúdo B</p>",
					summary: null,
					image_url: null,
					tags: [],
					published_at: new Date(),
					canonical_url: "https://destaques.gov.br/artigos/news-b",
				},
			],
		]);

		const result = await processPublishQueue(federation, 100, makeFetchNews(articles));

		expect(result.processed).toBe(3);
		expect(result.published).toBe(2);
		expect(result.failed).toBe(1);
		expect(sendActivity).toHaveBeenCalledTimes(2);

		const sql = getSql();
		const rows =
			await sql`SELECT news_unique_id, status FROM ap_publish_queue ORDER BY news_unique_id`;
		expect(rows[0]).toMatchObject({ news_unique_id: "news-a", status: "published" });
		expect(rows[1]).toMatchObject({ news_unique_id: "news-b", status: "published" });
		expect(rows[2]).toMatchObject({ news_unique_id: "news-c", status: "failed" });
	});

	it("respects limit parameter", async () => {
		await seedActor("agricultura");
		await enqueueItem("news-1", "agricultura");
		await enqueueItem("news-2", "agricultura");
		await enqueueItem("news-3", "agricultura");

		const { federation } = makeMockFederation();
		const articles = new Map<string, NewsRow>();
		for (const id of ["news-1", "news-2", "news-3"]) {
			articles.set(id, {
				unique_id: id,
				title: `Article ${id}`,
				content_html: "<p>content</p>",
				summary: null,
				image_url: null,
				tags: [],
				published_at: new Date(),
				canonical_url: `https://destaques.gov.br/artigos/${id}`,
			});
		}

		const result = await processPublishQueue(federation, 2, makeFetchNews(articles));

		expect(result.processed).toBe(2);
		expect(result.published).toBe(2);

		// One item should still be pending
		const sql = getSql();
		const [{ count }] =
			await sql`SELECT COUNT(*)::int as count FROM ap_publish_queue WHERE status = 'pending'`;
		expect(count).toBe(1);
	});

	it("skips already-published items", async () => {
		await seedActor("agricultura");
		const sql = getSql();
		await sql`
			INSERT INTO ap_publish_queue (news_unique_id, actor_identifier, status, processed_at)
			VALUES ('already-done', 'agricultura', 'published', NOW())
		`;
		await enqueueItem("news-new", "agricultura");

		const { federation, sendActivity } = makeMockFederation();
		const articles = new Map<string, NewsRow>([
			[
				"news-new",
				{
					unique_id: "news-new",
					title: "New article",
					content_html: "<p>new</p>",
					summary: null,
					image_url: null,
					tags: [],
					published_at: new Date(),
					canonical_url: "https://destaques.gov.br/artigos/news-new",
				},
			],
		]);

		const result = await processPublishQueue(federation, 100, makeFetchNews(articles));

		expect(result.processed).toBe(1);
		expect(result.published).toBe(1);
		expect(sendActivity).toHaveBeenCalledOnce();
	});

	it("handles sendActivity failure gracefully", async () => {
		await seedActor("agricultura");
		await enqueueItem("news-fail", "agricultura");

		const sendActivity = vi.fn().mockRejectedValue(new Error("Connection refused"));
		const federation = {
			createContext: vi.fn().mockReturnValue({ sendActivity }),
		} as never;

		const articles = new Map<string, NewsRow>([
			[
				"news-fail",
				{
					unique_id: "news-fail",
					title: "Article",
					content_html: "<p>content</p>",
					summary: null,
					image_url: null,
					tags: [],
					published_at: new Date(),
					canonical_url: "https://destaques.gov.br/artigos/news-fail",
				},
			],
		]);

		const result = await processPublishQueue(federation, 100, makeFetchNews(articles));

		expect(result.failed).toBe(1);
		expect(result.errors).toContain("news-fail: Connection refused");

		const sql = getSql();
		const [row] =
			await sql`SELECT status, error_message FROM ap_publish_queue WHERE news_unique_id = 'news-fail'`;
		expect(row.status).toBe("failed");
		expect(row.error_message).toBe("Connection refused");
	});
});
