import { Article, Create } from "@fedify/fedify";
import { describe, expect, it } from "vitest";
import { buildArticleActivity, type NewsRow } from "../../src/article-builder.js";

const DOMAIN = "destaques.gov.br";

function makeNews(overrides: Partial<NewsRow> = {}): NewsRow {
	return {
		unique_id: "abc123",
		title: "Nova política agrícola",
		content_html: "<p>Conteúdo do artigo sobre agricultura</p>",
		summary: "Resumo da política agrícola",
		image_url: "https://destaques.gov.br/images/agricultura.jpg",
		tags: ["agricultura", "politica"],
		published_at: new Date("2026-02-12T14:00:00Z"),
		canonical_url: "https://destaques.gov.br/artigos/abc123",
		...overrides,
	};
}

describe("buildArticleActivity", () => {
	it("returns a Create activity", () => {
		const activity = buildArticleActivity(makeNews(), "agricultura", DOMAIN);
		expect(activity).toBeInstanceOf(Create);
	});

	it("sets activity ID with unique_id and actor", () => {
		const activity = buildArticleActivity(makeNews(), "agricultura", DOMAIN);
		expect(activity.id?.href).toBe("https://destaques.gov.br/ap/activities/abc123-agricultura");
	});

	it("sets actor URI", () => {
		const activity = buildArticleActivity(makeNews(), "agricultura", DOMAIN);
		expect(activity.actorId?.href).toBe("https://destaques.gov.br/ap/actors/agricultura");
	});

	it("creates an Article object", async () => {
		const activity = buildArticleActivity(makeNews(), "agricultura", DOMAIN);
		const object = await activity.getObject();
		expect(object).toBeInstanceOf(Article);
	});

	it("maps title to Article name", async () => {
		const activity = buildArticleActivity(
			makeNews({ title: "Título Teste" }),
			"agricultura",
			DOMAIN,
		);
		const article = await activity.getObject();
		expect(article?.name?.toString()).toBe("Título Teste");
	});

	it("maps content_html to Article content", async () => {
		const activity = buildArticleActivity(makeNews(), "agricultura", DOMAIN);
		const article = await activity.getObject();
		expect(article?.content?.toString()).toContain("agricultura");
	});

	it("maps summary to Article summary", async () => {
		const activity = buildArticleActivity(makeNews(), "agricultura", DOMAIN);
		const article = await activity.getObject();
		expect(article?.summary?.toString()).toBe("Resumo da política agrícola");
	});

	it("generates canonical article URL", async () => {
		const activity = buildArticleActivity(makeNews(), "agricultura", DOMAIN);
		const article = await activity.getObject();
		expect(article?.url?.href).toBe("https://destaques.gov.br/artigos/abc123");
	});

	it("sets to=Public and cc=followers", () => {
		const activity = buildArticleActivity(makeNews(), "agricultura", DOMAIN);
		expect(
			activity.toIds.some((t) => t.href === "https://www.w3.org/ns/activitystreams#Public"),
		).toBe(true);
		expect(activity.ccIds.some((c) => c.href.includes("/followers"))).toBe(true);
	});

	it("handles null image", async () => {
		const activity = buildArticleActivity(makeNews({ image_url: null }), "agricultura", DOMAIN);
		const article = await activity.getObject();
		expect(article?.imageId).toBeNull();
	});

	it("handles empty tags", () => {
		const activity = buildArticleActivity(makeNews({ tags: [] }), "agricultura", DOMAIN);
		expect(activity).toBeInstanceOf(Create);
	});
});
