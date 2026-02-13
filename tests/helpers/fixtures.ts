// Minimal JWK key pairs for testing (not for production use)
export const TEST_RSA_PUBLIC_JWK = {
	kty: "RSA",
	n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
	e: "AQAB",
	alg: "RS256",
	use: "sig",
};

export const TEST_RSA_PRIVATE_JWK = {
	...TEST_RSA_PUBLIC_JWK,
	d: "X4cTteJY_gn4FYPsXB8rdXix5vwsg1FLN5E3EaG6RJoVH-HLLKD9M7dx5oo7GURknchnrRweUkC7hT5fJLM0WbFAKNLWY2vv7B6NqXSzUvxT0_YSfqijwp3RTzlBaCxWp4doFk5N2o8Gy_nHNKroADIkJ46pRUohsXywbReAdYaMwFs9tv8d_cPVY3i07a3t8MN6TNwm0dSawm9v47UiCl3Sk5ZiG7xojPLu4sbg1U2jx4IBTNBznbJSzFHK66jT8bgkuqsk0GjskDJk19Z4qwjwbsnn4j2WBii3RL-Us2lGVkY8fkFzme1z0HbIkfz0Y6mqnOYjqxnf7XyzRfkA",
	p: "83i-7IvMGXoMXCskv73TKr8637FiO7Z27zv8oj6pbWUQyLPQBQxtPVnwD20R-60eTDmD2ujnMt5PoqMrm8RfmNhVWDtjjMmCMjOpSXicFHj7XOuVIYQyqVWlWEh6dN36GVZYk93N8Bc9vY41xy8B9RzzOGVQzXvNEvn7O0nVbfs",
	q: "3dfOR9cuYq-0S-mkFLzgItgMEfFzB2q3hWehMuG0oCuqnb3vobLyumqjb37qSHyTOsOb7scYqaBJlXP-p5MIgTJprOTEB-7hCqXNJfVxi6ttQCxTJfkw4VsiECYLqCp0WC1JmFnVOHOiPZO3E6yMpe_kDg1gVr-XQSy7VaH3aOw",
	dp: "G4sPXkc6Ya9y8oJW9_ILj4xuppu0lzi_Hp67wjN_YfKUceyR8Isr_2RcAkMPcpbB4NNGKPB7Wy3Ad0YN64N-AOaS30BPsE2r5DTVhEN2xOX3OMj6HcN-RBBM0UO6CCAAA0eVbOQF0IF3i7sKp2cAXqLfMNIIzwreg_eIU",
	dq: "s9lAH9fggBsoFR8Oac2R_E2gw282rT2kGOAhvIllETE1efrA6huUUvMfBcMpn8lqeW6hE68oCppovJPTh6-I49kQ4_CJ3REh7MjCyPqj8GQ5i-y3x3KFQZWI9CqX2vZ3TF0BY-vFCCV7YGGKxKZMGiAMcLkDe9lN4e6szGqJED8",
	qi: "GyM_p6JrXySiz1toFgKbWV-JdnqZenIRGCSR8MLRs_EWQIN-uDKhe5v-3oGMZhLgMCIEB_pMQBDUfGE_7Bmj9drj-em_Q0AklofDgiZoHbIEUqnSg6DkVrKRnDSMwCRBnaqNq0IRYTxAoJwJchPDVDQ0ERnMSqaLCGGEfuC8eDQ",
};

export const TEST_ED25519_PUBLIC_JWK = {
	kty: "OKP",
	crv: "Ed25519",
	x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
};

export const TEST_ED25519_PRIVATE_JWK = {
	...TEST_ED25519_PUBLIC_JWK,
	d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
};

export function makeTestActor(overrides: Record<string, unknown> = {}) {
	return {
		identifier: "test-actor",
		actor_type: "agency",
		display_name: "Test Agency",
		summary: "A test agency for unit tests",
		icon_url: null,
		agency_key: "test-agency",
		theme_code: null,
		rsa_public_key_jwk: TEST_RSA_PUBLIC_JWK,
		rsa_private_key_jwk: TEST_RSA_PRIVATE_JWK,
		ed25519_public_key_jwk: TEST_ED25519_PUBLIC_JWK,
		ed25519_private_key_jwk: TEST_ED25519_PRIVATE_JWK,
		...overrides,
	};
}

export const TEST_ACTORS = {
	portal: makeTestActor({
		identifier: "portal",
		actor_type: "portal",
		display_name: "Destaques GOV.BR",
		summary: "Portal de notícias do governo federal",
		agency_key: null,
	}),
	agricultura: makeTestActor({
		identifier: "agricultura",
		actor_type: "agency",
		display_name: "Ministério da Agricultura",
		agency_key: "agricultura",
	}),
	tema01: makeTestActor({
		identifier: "tema-01",
		actor_type: "theme",
		display_name: "Economia e Finanças",
		agency_key: null,
		theme_code: "01",
	}),
};
