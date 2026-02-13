/**
 * Key management for ActivityPub actors.
 * Each actor has an RSA-2048 key pair (HTTP Signatures) and an Ed25519 key pair (Object Integrity Proofs).
 * Keys are stored as JWK in the database.
 */

export interface ExportedKeyPair {
	publicKey: JsonWebKey;
	privateKey: JsonWebKey;
}

export async function generateRsaKeyPair(): Promise<CryptoKeyPair> {
	return crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	);
}

export async function generateEd25519KeyPair(): Promise<CryptoKeyPair> {
	return crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
}

export async function exportKeyPairToJwk(keyPair: CryptoKeyPair): Promise<ExportedKeyPair> {
	const [publicKey, privateKey] = await Promise.all([
		crypto.subtle.exportKey("jwk", keyPair.publicKey),
		crypto.subtle.exportKey("jwk", keyPair.privateKey),
	]);
	return { publicKey, privateKey };
}

export async function importRsaKeyPairFromJwk(jwk: ExportedKeyPair): Promise<CryptoKeyPair> {
	const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
	const [publicKey, privateKey] = await Promise.all([
		crypto.subtle.importKey("jwk", jwk.publicKey, algorithm, true, ["verify"]),
		crypto.subtle.importKey("jwk", jwk.privateKey, algorithm, true, ["sign"]),
	]);
	return { publicKey, privateKey };
}

export async function importEd25519KeyPairFromJwk(jwk: ExportedKeyPair): Promise<CryptoKeyPair> {
	const [publicKey, privateKey] = await Promise.all([
		crypto.subtle.importKey("jwk", jwk.publicKey, "Ed25519", true, ["verify"]),
		crypto.subtle.importKey("jwk", jwk.privateKey, "Ed25519", true, ["sign"]),
	]);
	return { publicKey, privateKey };
}
