import { Application, Group, Organization } from "@fedify/fedify";
import { describe, expect, it } from "vitest";
import { buildActor } from "../../src/actors.js";

describe("buildActor", () => {
	const baseProps = {
		id: new URL("https://example.com/ap/actors/test"),
		preferredUsername: "test",
		name: "Test Actor",
	};

	it("returns Organization for agency type", () => {
		const actor = buildActor("agency", baseProps);
		expect(actor).toBeInstanceOf(Organization);
	});

	it("returns Group for theme type", () => {
		const actor = buildActor("theme", baseProps);
		expect(actor).toBeInstanceOf(Group);
	});

	it("returns Application for portal type", () => {
		const actor = buildActor("portal", baseProps);
		expect(actor).toBeInstanceOf(Application);
	});

	it("sets preferredUsername on the actor", async () => {
		const actor = buildActor("agency", {
			...baseProps,
			preferredUsername: "agricultura",
		});
		expect(actor.preferredUsername?.toString()).toBe("agricultura");
	});

	it("sets name on the actor", async () => {
		const actor = buildActor("agency", {
			...baseProps,
			name: "Ministério da Agricultura",
		});
		expect(actor.name?.toString()).toBe("Ministério da Agricultura");
	});

	it("sets summary on the actor", async () => {
		const actor = buildActor("theme", {
			...baseProps,
			summary: "Notícias sobre economia",
		});
		expect(actor.summary?.toString()).toBe("Notícias sobre economia");
	});
});
