import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cleanE2ETables,
	enqueuePublish,
	getE2EAuthToken,
	getE2EServerUrl,
	getPublishQueueStatus,
	seedActor,
	setupE2E,
	teardownE2E,
} from "../helpers/e2e.js";

const BASE = getE2EServerUrl();
const AUTH_TOKEN = getE2EAuthToken();

describe("e2e: publish flow", () => {
	beforeAll(async () => {
		await setupE2E();
		await cleanE2ETables();
		await seedActor({
			identifier: "agricultura",
			actorType: "agency",
			displayName: "Ministério da Agricultura",
		});
	});

	afterAll(async () => {
		await cleanE2ETables();
		await teardownE2E();
	});

	it("rejects trigger-publish without auth", async () => {
		const res = await fetch(`${BASE}/trigger-publish`, {
			method: "POST",
		});
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error).toBe("Unauthorized");
	});

	it("rejects trigger-publish with wrong token", async () => {
		const res = await fetch(`${BASE}/trigger-publish`, {
			method: "POST",
			headers: { Authorization: "Bearer wrong-token" },
		});
		expect(res.status).toBe(401);
	});

	it("trigger-publish with valid token processes empty queue", async () => {
		const res = await fetch(`${BASE}/trigger-publish`, {
			method: "POST",
			headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.processed).toBe(0);
		expect(body.published).toBe(0);
		expect(body.failed).toBe(0);
	});

	it("trigger-publish processes queued items (fails without fetchNews)", async () => {
		await enqueuePublish("e2e-news-001", "agricultura");

		const res = await fetch(`${BASE}/trigger-publish`, {
			method: "POST",
			headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		// Without a fetchNews function wired, items fail with "News article not found"
		expect(body.processed).toBe(1);
		expect(body.failed).toBe(1);

		const status = await getPublishQueueStatus("e2e-news-001");
		expect(status.status).toBe("failed");
		expect(status.error_message).toContain("News article not found");
	});
});
