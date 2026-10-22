import { describe, expect, it } from "vitest";
import { resolveActorIdentifiers } from "../../src/pubsub-handler.js";

describe("resolveActorIdentifiers", () => {
	it("routes to portal, agency and the L1 theme actor of the most specific theme", () => {
		// O evento dgb.news.enriched traz o código mais específico (em geral L3),
		// mas só existem atores de tema L1 (tema-01 … tema-26).
		expect(resolveActorIdentifiers("mdr", "26.01.03")).toEqual(["portal", "mdr", "tema-26"]);
		expect(resolveActorIdentifiers("mec", "02.01")).toEqual(["portal", "mec", "tema-02"]);
		expect(resolveActorIdentifiers("defesa", "19")).toEqual(["portal", "defesa", "tema-19"]);
	});

	it("skips agency and theme when absent", () => {
		expect(resolveActorIdentifiers(null, null)).toEqual(["portal"]);
		expect(resolveActorIdentifiers("mec", "")).toEqual(["portal", "mec"]);
		expect(resolveActorIdentifiers(null, "03.02.01")).toEqual(["portal", "tema-03"]);
	});
});
