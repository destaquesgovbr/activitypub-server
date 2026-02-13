import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	cleanE2ETables,
	getE2EServerUrl,
	seedActor,
	setupE2E,
	teardownE2E,
} from "../helpers/e2e.js";

const BASE = getE2EServerUrl();

describe("e2e: discovery", () => {
	beforeAll(async () => {
		await setupE2E();
		await cleanE2ETables();
		await seedActor({
			identifier: "agricultura",
			actorType: "agency",
			displayName: "Ministério da Agricultura",
			summary: "Notícias do Ministério da Agricultura",
		});
		await seedActor({
			identifier: "portal",
			actorType: "portal",
			displayName: "Destaques GOV.BR",
			summary: "Portal de notícias do governo federal",
		});
		await seedActor({
			identifier: "tema-economia",
			actorType: "theme",
			displayName: "Economia e Finanças",
		});
	});

	afterAll(async () => {
		await cleanE2ETables();
		await teardownE2E();
	});

	it("health endpoint returns ok", async () => {
		const res = await fetch(`${BASE}/health`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("ok");
	});

	it("WebFinger resolves agency actor", async () => {
		const res = await fetch(
			`${BASE}/.well-known/webfinger?resource=acct:agricultura@localhost:3000`,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.subject).toBe("acct:agricultura@localhost:3000");
		expect(body.links).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					rel: "self",
					type: "application/activity+json",
				}),
			]),
		);
	});

	it("WebFinger resolves portal actor", async () => {
		const res = await fetch(`${BASE}/.well-known/webfinger?resource=acct:portal@localhost:3000`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.subject).toBe("acct:portal@localhost:3000");
	});

	it("WebFinger returns 404 for unknown actor", async () => {
		const res = await fetch(
			`${BASE}/.well-known/webfinger?resource=acct:nonexistent@localhost:3000`,
		);
		expect(res.status).toBe(404);
	});

	it("actor profile returns JSON-LD for agency (Organization)", async () => {
		const res = await fetch(`${BASE}/ap/actors/agricultura`, {
			headers: { Accept: "application/activity+json" },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.type).toBe("Organization");
		expect(body.preferredUsername).toBe("agricultura");
		expect(body.name).toBe("Ministério da Agricultura");
		expect(body.summary).toBe("Notícias do Ministério da Agricultura");
		expect(body.inbox).toContain("/ap/actors/agricultura/inbox");
		expect(body.outbox).toContain("/ap/actors/agricultura/outbox");
		expect(body.followers).toContain("/ap/actors/agricultura/followers");
		expect(body.publicKey).toBeDefined();
		expect(body.publicKey.publicKeyPem).toBeDefined();
	});

	it("actor profile returns JSON-LD for portal (Application)", async () => {
		const res = await fetch(`${BASE}/ap/actors/portal`, {
			headers: { Accept: "application/activity+json" },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.type).toBe("Application");
		expect(body.preferredUsername).toBe("portal");
	});

	it("actor profile returns JSON-LD for theme (Group)", async () => {
		const res = await fetch(`${BASE}/ap/actors/tema-economia`, {
			headers: { Accept: "application/activity+json" },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.type).toBe("Group");
		expect(body.preferredUsername).toBe("tema-economia");
	});

	it("actor profile returns 404 for unknown actor", async () => {
		const res = await fetch(`${BASE}/ap/actors/unknown`, {
			headers: { Accept: "application/activity+json" },
		});
		expect(res.status).toBe(404);
	});

	it("outbox returns empty OrderedCollection", async () => {
		const res = await fetch(`${BASE}/ap/actors/agricultura/outbox`, {
			headers: { Accept: "application/activity+json" },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.type).toBe("OrderedCollection");
		expect(body.totalItems).toBe(0);
	});
});
