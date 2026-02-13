import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock db module
vi.mock("../../src/db.js", () => ({
	getPool: vi.fn(),
	getActorByIdentifier: vi.fn(),
	getPendingPublishQueue: vi.fn(),
	markPublished: vi.fn(),
	markFailed: vi.fn(),
}));

import {
	getActorByIdentifier,
	getPendingPublishQueue,
	markFailed,
	markPublished,
} from "../../src/db.js";
import { TEST_ACTORS } from "../helpers/fixtures.js";

const mockedGetQueue = vi.mocked(getPendingPublishQueue);
const mockedGetActor = vi.mocked(getActorByIdentifier);
const mockedMarkPublished = vi.mocked(markPublished);
const mockedMarkFailed = vi.mocked(markFailed);

describe("processPublishQueue", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns zero counts when queue is empty", async () => {
		mockedGetQueue.mockResolvedValue([]);

		const { processPublishQueue } = await import("../../src/publisher.js");
		const mockFedi = { createContext: vi.fn() } as never;
		const result = await processPublishQueue(mockFedi, 100);

		expect(result.processed).toBe(0);
		expect(result.published).toBe(0);
		expect(result.failed).toBe(0);
	});

	it("marks item as failed when actor not found", async () => {
		mockedGetQueue.mockResolvedValue([
			{
				id: 1,
				news_unique_id: "abc",
				actor_identifier: "unknown",
				status: "pending",
				error_message: null,
				queued_at: new Date(),
				processed_at: null,
			},
		]);
		mockedGetActor.mockResolvedValue(null);

		const { processPublishQueue } = await import("../../src/publisher.js");
		const mockFedi = { createContext: vi.fn() } as never;
		const result = await processPublishQueue(mockFedi, 100);

		expect(result.failed).toBe(1);
		expect(mockedMarkFailed).toHaveBeenCalledWith(1, expect.stringContaining("Actor not found"));
	});

	it("marks item as failed when news not found", async () => {
		mockedGetQueue.mockResolvedValue([
			{
				id: 2,
				news_unique_id: "missing",
				actor_identifier: "agricultura",
				status: "pending",
				error_message: null,
				queued_at: new Date(),
				processed_at: null,
			},
		]);
		mockedGetActor.mockResolvedValue({
			id: 1,
			...TEST_ACTORS.agricultura,
			is_active: true,
		} as never);

		const { processPublishQueue } = await import("../../src/publisher.js");
		const mockFedi = { createContext: vi.fn() } as never;
		const fetchNews = vi.fn().mockResolvedValue(null);
		const result = await processPublishQueue(mockFedi, 100, fetchNews);

		expect(result.failed).toBe(1);
		expect(mockedMarkFailed).toHaveBeenCalledWith(
			2,
			expect.stringContaining("News article not found"),
		);
	});

	it("publishes successfully when all data found", async () => {
		mockedGetQueue.mockResolvedValue([
			{
				id: 3,
				news_unique_id: "abc123",
				actor_identifier: "agricultura",
				status: "pending",
				error_message: null,
				queued_at: new Date(),
				processed_at: null,
			},
		]);
		mockedGetActor.mockResolvedValue({
			id: 1,
			...TEST_ACTORS.agricultura,
			is_active: true,
		} as never);
		mockedMarkPublished.mockResolvedValue(undefined);

		const mockSendActivity = vi.fn();
		const mockCtx = { sendActivity: mockSendActivity };
		const mockFedi = {
			createContext: vi.fn().mockReturnValue(mockCtx),
		} as never;

		const fetchNews = vi.fn().mockResolvedValue({
			unique_id: "abc123",
			title: "Test Article",
			content_html: "<p>Test</p>",
			summary: "Test summary",
			image_url: null,
			tags: [],
			published_at: new Date("2026-02-12T14:00:00Z"),
			canonical_url: "https://destaques.gov.br/artigos/abc123",
		});

		const { processPublishQueue } = await import("../../src/publisher.js");
		const result = await processPublishQueue(mockFedi, 100, fetchNews);

		expect(result.published).toBe(1);
		expect(result.failed).toBe(0);
		expect(mockedMarkPublished).toHaveBeenCalledWith(3);
		expect(mockSendActivity).toHaveBeenCalledWith(
			{ identifier: "agricultura" },
			"followers",
			expect.anything(),
			{ preferSharedInbox: true },
		);
	});

	it("handles sendActivity errors gracefully", async () => {
		mockedGetQueue.mockResolvedValue([
			{
				id: 4,
				news_unique_id: "abc",
				actor_identifier: "agricultura",
				status: "pending",
				error_message: null,
				queued_at: new Date(),
				processed_at: null,
			},
		]);
		mockedGetActor.mockResolvedValue({
			id: 1,
			...TEST_ACTORS.agricultura,
			is_active: true,
		} as never);

		const mockCtx = { sendActivity: vi.fn().mockRejectedValue(new Error("Network error")) };
		const mockFedi = {
			createContext: vi.fn().mockReturnValue(mockCtx),
		} as never;

		const fetchNews = vi.fn().mockResolvedValue({
			unique_id: "abc",
			title: "Test",
			content_html: "<p>Test</p>",
			summary: null,
			image_url: null,
			tags: [],
			published_at: new Date(),
			canonical_url: "https://example.com/abc",
		});

		const { processPublishQueue } = await import("../../src/publisher.js");
		const result = await processPublishQueue(mockFedi, 100, fetchNews);

		expect(result.failed).toBe(1);
		expect(mockedMarkFailed).toHaveBeenCalledWith(4, "Network error");
	});
});

describe("trigger-publish auth", () => {
	it("rejects requests without auth token", async () => {
		const { createTriggerPublishHandler } = await import("../../src/publisher.js");
		const handler = createTriggerPublishHandler({} as never);

		const mockJson = vi.fn().mockReturnValue(new Response());
		const mockC = {
			req: { header: vi.fn().mockReturnValue(undefined), query: vi.fn() },
			json: mockJson,
		};

		await handler(mockC as never);

		expect(mockJson).toHaveBeenCalledWith({ error: "Unauthorized" }, 401);
	});
});
