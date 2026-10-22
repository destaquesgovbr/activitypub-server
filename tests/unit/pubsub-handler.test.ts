import type { Federation } from "@fedify/fedify";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/govbrnews-db.js", () => ({
	fetchArticle: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({
	insertPublishQueueEntries: vi.fn(),
}));
vi.mock("../../src/publisher.js", () => ({
	processPublishQueue: vi.fn(),
}));

import { insertPublishQueueEntries } from "../../src/db.js";
import { fetchArticle, type GovbrNewsArticle } from "../../src/govbrnews-db.js";
import { processPublishQueue } from "../../src/publisher.js";
import { createPubSubHandler, resolveActorIdentifiers } from "../../src/pubsub-handler.js";

const mockedFetchArticle = vi.mocked(fetchArticle);
const mockedInsert = vi.mocked(insertPublishQueueEntries);
const mockedProcess = vi.mocked(processPublishQueue);

describe("resolveActorIdentifiers", () => {
	it("routes to portal, agency and the actor of the canonical L1 (news.theme_l1_id)", () => {
		expect(resolveActorIdentifiers("mdr", "26", "26.01.03")).toEqual(["portal", "mdr", "tema-26"]);
		expect(resolveActorIdentifiers("mec", "02", null)).toEqual(["portal", "mec", "tema-02"]);
	});

	it("prefers the canonical L1 when the most specific code has another prefix", () => {
		// Hierarquia inconsistente do classificador: L1 15, mais específico 24.01.
		// Portal e Typesense mostram o L1 15; o ator também tem de ser o tema-15.
		expect(resolveActorIdentifiers("mdh", "15", "24.01")).toEqual(["portal", "mdh", "tema-15"]);
	});

	it("falls back to the L1 prefix of the most specific code when the article has no L1", () => {
		// O evento dgb.news.enriched traz o código mais específico (em geral L3),
		// mas só existem atores de tema L1 (tema-01 … tema-26).
		expect(resolveActorIdentifiers("mdr", null, "26.01.03")).toEqual(["portal", "mdr", "tema-26"]);
		expect(resolveActorIdentifiers(null, "", "03.02.01")).toEqual(["portal", "tema-03"]);
		expect(resolveActorIdentifiers("defesa", undefined, "19")).toEqual([
			"portal",
			"defesa",
			"tema-19",
		]);
	});

	it("skips agency and theme when absent", () => {
		expect(resolveActorIdentifiers(null, null, null)).toEqual(["portal"]);
		expect(resolveActorIdentifiers("mec", null, "")).toEqual(["portal", "mec"]);
	});
});

const ARTICLE: GovbrNewsArticle = {
	unique_id: "abc123",
	title: "Chuvas no RS",
	content: "<p>Texto</p>",
	url: "https://www.gov.br/mdr/noticia",
	image_url: null,
	tags: null,
	published_at: new Date("2026-10-20T12:00:00Z"),
	agency_key: "mdr",
	theme_l1_code: "26",
};

async function postEnrichedEvent(payload: Record<string, unknown>) {
	const app = new Hono();
	app.post("/process", createPubSubHandler({} as Federation<void>));
	const data = Buffer.from(JSON.stringify(payload)).toString("base64");
	const res = await app.request("/process", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message: { data } }),
	});
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function queuedActors(): string[] {
	expect(mockedInsert).toHaveBeenCalledTimes(1);
	return mockedInsert.mock.calls[0][0].map((entry) => entry.actorIdentifier);
}

describe("createPubSubHandler", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedInsert.mockResolvedValue(3);
		mockedProcess.mockResolvedValue({ processed: 3, published: 3, failed: 0, errors: [] });
	});

	it("queues the theme actor of the article's canonical L1, not of the event's prefix", async () => {
		mockedFetchArticle.mockResolvedValue({ ...ARTICLE, agency_key: "mdh", theme_l1_code: "15" });

		const { status, body } = await postEnrichedEvent({
			unique_id: "abc123",
			most_specific_theme_code: "24.01",
		});

		expect(status).toBe(200);
		expect(mockedFetchArticle).toHaveBeenCalledWith("abc123");
		expect(queuedActors()).toEqual(["portal", "mdh", "tema-15"]);
		expect(body.actors).toEqual(["portal", "mdh", "tema-15"]);
		expect(mockedProcess).toHaveBeenCalledTimes(1);
	});

	it("queues the L1 theme actor even when the event has no most specific code", async () => {
		mockedFetchArticle.mockResolvedValue(ARTICLE);

		// O worker de enriquecimento manda "" quando não há código.
		await postEnrichedEvent({ unique_id: "abc123", most_specific_theme_code: "" });

		expect(queuedActors()).toEqual(["portal", "mdr", "tema-26"]);
	});

	it("falls back to the event's most specific code when the article has no L1", async () => {
		mockedFetchArticle.mockResolvedValue({ ...ARTICLE, theme_l1_code: null });

		await postEnrichedEvent({ unique_id: "abc123", most_specific_theme_code: "26.02.04" });

		expect(queuedActors()).toEqual(["portal", "mdr", "tema-26"]);
	});

	it("builds the same news payload for every actor", async () => {
		mockedFetchArticle.mockResolvedValue(ARTICLE);

		await postEnrichedEvent({ unique_id: "abc123", most_specific_theme_code: "26.01.03" });

		const entries = mockedInsert.mock.calls[0][0];
		expect(entries).toHaveLength(3);
		for (const entry of entries) {
			expect(entry.newsUniqueId).toBe("abc123");
			expect(entry.newsPayload).toEqual({
				unique_id: "abc123",
				title: "Chuvas no RS",
				content_html: "<p>Texto</p>",
				summary: null,
				image_url: null,
				tags: [],
				published_at: "2026-10-20T12:00:00.000Z",
				canonical_url: "https://www.gov.br/mdr/noticia",
			});
		}
	});
});
