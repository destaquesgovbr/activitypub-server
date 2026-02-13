import { describe, expect, it } from "vitest";
import {
	exportKeyPairToJwk,
	generateEd25519KeyPair,
	generateRsaKeyPair,
	importEd25519KeyPairFromJwk,
	importRsaKeyPairFromJwk,
} from "../../src/keys.js";

describe("keys", () => {
	describe("RSA-2048", () => {
		it("generates RSA key pair and exports as JWK", async () => {
			const keyPair = await generateRsaKeyPair();
			const jwk = await exportKeyPairToJwk(keyPair);

			expect(jwk.publicKey.kty).toBe("RSA");
			expect(jwk.publicKey.n).toBeDefined();
			expect(jwk.publicKey.e).toBe("AQAB");
			expect(jwk.privateKey.d).toBeDefined();
		});

		it("imports JWK back to CryptoKeyPair", async () => {
			const keyPair = await generateRsaKeyPair();
			const jwk = await exportKeyPairToJwk(keyPair);
			const imported = await importRsaKeyPairFromJwk(jwk);

			expect(imported.publicKey).toBeInstanceOf(CryptoKey);
			expect(imported.privateKey).toBeInstanceOf(CryptoKey);
		});

		it("roundtrip: generate → export → import → sign → verify", async () => {
			const keyPair = await generateRsaKeyPair();
			const jwk = await exportKeyPairToJwk(keyPair);
			const imported = await importRsaKeyPairFromJwk(jwk);

			const data = new TextEncoder().encode("test message for signing");
			const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", imported.privateKey, data);
			const valid = await crypto.subtle.verify(
				"RSASSA-PKCS1-v1_5",
				imported.publicKey,
				signature,
				data,
			);

			expect(valid).toBe(true);
		});
	});

	describe("Ed25519", () => {
		it("generates Ed25519 key pair and exports as JWK", async () => {
			const keyPair = await generateEd25519KeyPair();
			const jwk = await exportKeyPairToJwk(keyPair);

			expect(jwk.publicKey.kty).toBe("OKP");
			expect(jwk.publicKey.crv).toBe("Ed25519");
			expect(jwk.publicKey.x).toBeDefined();
			expect(jwk.privateKey.d).toBeDefined();
		});

		it("imports JWK back to CryptoKeyPair", async () => {
			const keyPair = await generateEd25519KeyPair();
			const jwk = await exportKeyPairToJwk(keyPair);
			const imported = await importEd25519KeyPairFromJwk(jwk);

			expect(imported.publicKey).toBeInstanceOf(CryptoKey);
			expect(imported.privateKey).toBeInstanceOf(CryptoKey);
		});

		it("roundtrip: generate → export → import → sign → verify", async () => {
			const keyPair = await generateEd25519KeyPair();
			const jwk = await exportKeyPairToJwk(keyPair);
			const imported = await importEd25519KeyPairFromJwk(jwk);

			const data = new TextEncoder().encode("test message for ed25519");
			const signature = await crypto.subtle.sign("Ed25519", imported.privateKey, data);
			const valid = await crypto.subtle.verify("Ed25519", imported.publicKey, signature, data);

			expect(valid).toBe(true);
		});
	});
});
