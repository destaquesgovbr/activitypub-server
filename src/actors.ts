import {
	Application,
	type Context,
	Endpoints,
	type Federation,
	Group,
	Image,
	Organization,
	type RequestContext,
} from "@fedify/fedify";
import { type ActorRow, getActorByIdentifier } from "./db.js";
import { importEd25519KeyPairFromJwk, importRsaKeyPairFromJwk } from "./keys.js";

export function registerActors(federation: Federation<void>) {
	federation
		.setActorDispatcher("/ap/actors/{identifier}", actorDispatcher)
		.setKeyPairsDispatcher(keyPairsDispatcher);

	// Register inbox/outbox/followers paths so ctx.getInboxUri() etc. work.
	// Actual inbox handlers are added in Phase 3.
	federation.setInboxListeners("/ap/actors/{identifier}/inbox", "/ap/inbox");
	federation.setOutboxDispatcher("/ap/actors/{identifier}/outbox", (_ctx, _identifier) => ({
		items: [],
	}));
	federation.setFollowersDispatcher("/ap/actors/{identifier}/followers", (_ctx, _identifier) => ({
		items: [],
	}));
}

async function actorDispatcher(ctx: RequestContext<void>, identifier: string) {
	const actor = await getActorByIdentifier(identifier);
	if (!actor) return null;

	const keys = await ctx.getActorKeyPairs(identifier);

	const baseProps = {
		id: ctx.getActorUri(identifier),
		preferredUsername: identifier,
		name: actor.display_name,
		summary: actor.summary,
		inbox: ctx.getInboxUri(identifier),
		outbox: ctx.getOutboxUri(identifier),
		followers: ctx.getFollowersUri(identifier),
		endpoints: new Endpoints({ sharedInbox: ctx.getInboxUri() }),
		publicKey: keys[0]?.cryptographicKey,
		assertionMethods: keys.slice(1).map((k) => k.multikey),
		discoverable: true,
		indexable: true,
		icon: actor.icon_url ? new Image({ url: new URL(actor.icon_url) }) : null,
	};

	return buildActor(actor.actor_type, baseProps);
}

async function keyPairsDispatcher(_ctx: Context<void>, identifier: string) {
	const actor = await getActorByIdentifier(identifier);
	if (!actor) return [];

	const rsaPair = await importRsaKeyPairFromJwk({
		publicKey: actor.rsa_public_key_jwk as JsonWebKey,
		privateKey: actor.rsa_private_key_jwk as JsonWebKey,
	});

	const pairs: CryptoKeyPair[] = [rsaPair];

	if (actor.ed25519_public_key_jwk && actor.ed25519_private_key_jwk) {
		const ed25519Pair = await importEd25519KeyPairFromJwk({
			publicKey: actor.ed25519_public_key_jwk as JsonWebKey,
			privateKey: actor.ed25519_private_key_jwk as JsonWebKey,
		});
		pairs.push(ed25519Pair);
	}

	return pairs;
}

export function buildActor(actorType: ActorRow["actor_type"], props: Record<string, unknown>) {
	switch (actorType) {
		case "agency":
			return new Organization(props);
		case "theme":
			return new Group(props);
		case "portal":
			return new Application(props);
	}
}
