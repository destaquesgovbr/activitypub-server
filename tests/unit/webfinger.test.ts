import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_ACTORS } from "../helpers/fixtures.js";

// Mock db module before importing the app
vi.mock("../../src/db.js", () => ({
	getPool: vi.fn(),
	getActorByIdentifier: vi.fn(),
}));

import { getActorByIdentifier } from "../../src/db.js";
import { createTestApp } from "../helpers/app.js";

const mockedGetActor = vi.mocked(getActorByIdentifier);

describe("WebFinger", () => {
	let app: Awaited<ReturnType<typeof createTestApp>>;

	beforeEach(async () => {
		vi.clearAllMocks();
		app = await createTestApp();
	});

	it("returns JRD for acct:agricultura@localhost", async () => {
		mockedGetActor.mockResolvedValue({
			id: 1,
			...TEST_ACTORS.agricultura,
			is_active: true,
		} as never);

		const res = await app.request("/.well-known/webfinger?resource=acct:agricultura@localhost", {
			headers: { Accept: "application/jrd+json" },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.subject).toBe("acct:agricultura@localhost");
		expect(body.links).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					rel: "self",
					type: "application/activity+json",
				}),
			]),
		);
	});

	it("returns 404 for unknown actor", async () => {
		mockedGetActor.mockResolvedValue(null);

		const res = await app.request("/.well-known/webfinger?resource=acct:nonexistent@localhost");
		expect(res.status).toBe(404);
	});

	it("returns 400 when resource param is missing", async () => {
		const res = await app.request("/.well-known/webfinger");
		expect(res.status).toBe(400);
	});
});

describe("Actor profile", () => {
	let app: Awaited<ReturnType<typeof createTestApp>>;

	beforeEach(async () => {
		vi.clearAllMocks();
		app = await createTestApp();
	});

	it("returns Organization JSON-LD for agency actor", async () => {
		mockedGetActor.mockResolvedValue({
			id: 1,
			...TEST_ACTORS.agricultura,
			is_active: true,
		} as never);

		const res = await app.request("/ap/actors/agricultura", {
			headers: { Accept: "application/activity+json" },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.type).toBe("Organization");
		expect(body.preferredUsername).toBe("agricultura");
		expect(body.name).toBe("Ministério da Agricultura");
	});

	it("returns Group JSON-LD for theme actor", async () => {
		mockedGetActor.mockResolvedValue({
			id: 2,
			...TEST_ACTORS.tema01,
			is_active: true,
		} as never);

		const res = await app.request("/ap/actors/tema-01", {
			headers: { Accept: "application/activity+json" },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.type).toBe("Group");
		expect(body.preferredUsername).toBe("tema-01");
	});

	it("returns Application JSON-LD for portal actor", async () => {
		mockedGetActor.mockResolvedValue({
			id: 3,
			...TEST_ACTORS.portal,
			is_active: true,
		} as never);

		const res = await app.request("/ap/actors/portal", {
			headers: { Accept: "application/activity+json" },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.type).toBe("Application");
		expect(body.preferredUsername).toBe("portal");
	});

	it("returns 404 for non-existent actor", async () => {
		mockedGetActor.mockResolvedValue(null);

		const res = await app.request("/ap/actors/nonexistent", {
			headers: { Accept: "application/activity+json" },
		});
		expect(res.status).toBe(404);
	});

	it("includes inbox and outbox URIs", async () => {
		mockedGetActor.mockResolvedValue({
			id: 1,
			...TEST_ACTORS.agricultura,
			is_active: true,
		} as never);

		const res = await app.request("/ap/actors/agricultura", {
			headers: { Accept: "application/activity+json" },
		});
		const body = await res.json();
		expect(body.inbox).toContain("/ap/actors/agricultura/inbox");
		expect(body.outbox).toContain("/ap/actors/agricultura/outbox");
	});

	it("includes publicKey", async () => {
		mockedGetActor.mockResolvedValue({
			id: 1,
			...TEST_ACTORS.agricultura,
			is_active: true,
		} as never);

		const res = await app.request("/ap/actors/agricultura", {
			headers: { Accept: "application/activity+json" },
		});
		const body = await res.json();
		expect(body.publicKey).toBeDefined();
		expect(body.publicKey.publicKeyPem).toBeDefined();
	});
});
