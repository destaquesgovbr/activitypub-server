import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/db.js", () => ({
	getPool: vi.fn(),
	getActorByIdentifier: vi.fn(),
	getPublishedItemsForActor: vi.fn(),
}));

import { getPublishedItemsForActor } from "../../src/db.js";
import { createTestApp } from "../helpers/app.js";

const mockedGetItems = vi.mocked(getPublishedItemsForActor);

describe("outbox dispatcher", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns OrderedCollection with totalItems", async () => {
		mockedGetItems.mockResolvedValue({ items: [], totalCount: 5 });

		const app = await createTestApp();
		const res = await app.request("/ap/actors/agricultura/outbox", {
			headers: { Accept: "application/activity+json" },
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.type).toBe("OrderedCollection");
		expect(body.totalItems).toBe(5);
	});

	it("returns empty outbox when no published items", async () => {
		mockedGetItems.mockResolvedValue({ items: [], totalCount: 0 });

		const app = await createTestApp();
		const res = await app.request("/ap/actors/agricultura/outbox", {
			headers: { Accept: "application/activity+json" },
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.totalItems).toBe(0);
	});

	it("returns outbox page with Create activities", async () => {
		mockedGetItems.mockResolvedValue({
			items: [
				{
					id: 1,
					news_unique_id: "news-001",
					actor_identifier: "agricultura",
					status: "published" as const,
					error_message: null,
					queued_at: new Date("2026-02-12T10:00:00Z"),
					processed_at: new Date("2026-02-12T10:05:00Z"),
				},
				{
					id: 2,
					news_unique_id: "news-002",
					actor_identifier: "agricultura",
					status: "published" as const,
					error_message: null,
					queued_at: new Date("2026-02-12T11:00:00Z"),
					processed_at: new Date("2026-02-12T11:05:00Z"),
				},
			],
			totalCount: 2,
		});

		const app = await createTestApp();
		// Request the first page (cursor=0)
		const res = await app.request("/ap/actors/agricultura/outbox?cursor=0", {
			headers: { Accept: "application/activity+json" },
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.type).toBe("OrderedCollectionPage");
		expect(body.orderedItems).toHaveLength(2);
		expect(body.orderedItems[0].type).toBe("Create");
		expect(body.orderedItems[0].id).toContain("news-001-agricultura");
		expect(body.orderedItems[1].id).toContain("news-002-agricultura");
	});

	it("includes next page link when more items exist", async () => {
		// First call for the page (limit 20), second for counter
		mockedGetItems.mockImplementation(async (_identifier, limit, _offset) => {
			if (limit === 0) return { items: [], totalCount: 25 };
			return { items: [], totalCount: 25 };
		});

		const app = await createTestApp();
		const res = await app.request("/ap/actors/agricultura/outbox?cursor=0", {
			headers: { Accept: "application/activity+json" },
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.next).toBeDefined();
	});

	it("omits next page link on last page", async () => {
		mockedGetItems.mockResolvedValue({ items: [], totalCount: 5 });

		const app = await createTestApp();
		const res = await app.request("/ap/actors/agricultura/outbox?cursor=0", {
			headers: { Accept: "application/activity+json" },
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.next).toBeUndefined();
	});
});
