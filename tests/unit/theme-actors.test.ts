import { describe, expect, it } from "vitest";
import {
	parseThemeLabels,
	planThemeActorSync,
	themeActorIdentifier,
} from "../../src/theme-actors.js";

// Trecho no formato de themes/themes_tree.yaml (3.2), com cabeçalho de comentários.
const THEMES_TREE = `# Árvore Temática - DestaquesGovBr (apenas códigos e nomes)
# Versão: 3.2
# 3.2: novo L1 26 - Defesa Civil e Gestão de Desastres (19.03 → 26.01, 19.04 → 26.02; DEC-006).

01 - Economia e Finanças:
  01.01 - Política Econômica:
    - 01.01.01 - Política Fiscal

19 - Defesa e Forças Armadas:
  19.01 - Segurança Nacional:
    - 19.01.01 - Inteligência e Contrainteligência

25 - Habitação e Urbanismo:
  25.01 - Programas Habitacionais:

26 - Defesa Civil e Gestão de Desastres:
  26.01 - Defesa Civil:
    - 26.01.01 - Preparação para Desastres
  26.02 - Situações de Emergência:
    - 26.02.05 - Assistência a Deslocados Internos
`;

describe("parseThemeLabels", () => {
	it("returns only L1 themes, in file order, ignoring comments", () => {
		const labels = parseThemeLabels(THEMES_TREE);
		expect([...labels.entries()]).toEqual([
			["01", "Economia e Finanças"],
			["19", "Defesa e Forças Armadas"],
			["25", "Habitação e Urbanismo"],
			["26", "Defesa Civil e Gestão de Desastres"],
		]);
	});
});

describe("themeActorIdentifier", () => {
	it.each([
		["26.01.03", "tema-26"],
		["26.02", "tema-26"],
		["19", "tema-19"],
		["02.01.04", "tema-02"],
		[" 05.02.01 ", "tema-05"],
	])("maps %s to the L1 actor %s", (code, expected) => {
		expect(themeActorIdentifier(code)).toBe(expected);
	});

	it.each([
		[null],
		[undefined],
		[""],
		["abc"],
		["1"],
		["123.01"],
	])("returns null for %s", (code) => {
		expect(themeActorIdentifier(code)).toBeNull();
	});
});

describe("planThemeActorSync", () => {
	const labels = new Map([
		["01", "Economia e Finanças"],
		["19", "Defesa e Forças Armadas"],
		["24", "Minorias e Grupos Especiais"],
		["26", "Defesa Civil e Gestão de Desastres"],
	]);

	it("creates missing L1 actors, deactivates removed ones and reactivates returning ones", () => {
		const plan = planThemeActorSync(
			[
				{ identifier: "tema-01", theme_code: "01", is_active: true },
				{ identifier: "tema-19", theme_code: "19", is_active: null },
				{ identifier: "tema-22", theme_code: "22", is_active: true },
				{ identifier: "tema-23", theme_code: "23", is_active: true },
				{ identifier: "tema-24", theme_code: "24", is_active: false },
			],
			labels,
		);

		expect(plan.create).toEqual([
			{ identifier: "tema-26", code: "26", label: "Defesa Civil e Gestão de Desastres" },
		]);
		expect(plan.deactivate).toEqual(["tema-22", "tema-23"]);
		expect(plan.reactivate).toEqual(["tema-24"]);
	});

	it("is a no-op when actors already match the taxonomy", () => {
		const plan = planThemeActorSync(
			[
				{ identifier: "tema-01", theme_code: "01", is_active: true },
				{ identifier: "tema-19", theme_code: "19", is_active: true },
				{ identifier: "tema-22", theme_code: "22", is_active: false },
				{ identifier: "tema-24", theme_code: "24", is_active: true },
				{ identifier: "tema-26", theme_code: "26", is_active: true },
			],
			labels,
		);
		expect(plan).toEqual({ create: [], deactivate: [], reactivate: [] });
	});

	it("refuses an empty taxonomy instead of deactivating every theme actor", () => {
		expect(() =>
			planThemeActorSync([{ identifier: "tema-01", theme_code: "01", is_active: true }], new Map()),
		).toThrow(/nenhum tema L1/i);
	});
});
