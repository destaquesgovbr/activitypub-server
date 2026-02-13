# Plano de Execução Integrado — activitypub-server

Referencia:
- [`activitypub-plano.md`](./activitypub-plano.md) — Arquitetura, schema, infra
- [`testes-plano.md`](./testes-plano.md) — Suite de testes detalhada

## Metodologia

**Test-first por módulo dentro de cada fase.**

Para cada módulo:
1. Explorar a API do Fedify relevante (docs, exemplos)
2. Escrever testes (unit + integration quando aplicável)
3. Implementar código até os testes passarem
4. Refinar e seguir para o próximo módulo

Exceção: testes de integração com Postgres são **schema-first** — o SQL é a spec.

---

## Fase 0: Scaffold do Projeto

**Objetivo**: Repo funcional com tooling configurado, sem lógica de negócio.

### Passos

1. **Inicializar repositório**
   - `pnpm init`, `tsconfig.json`, `.gitignore`
   - Instalar dependências core: `@fedify/fedify`, `@fedify/postgres`, `hono`, `postgres`
   - Instalar devDeps: `vitest`, `typescript`, `@testcontainers/postgresql`, `testcontainers`
   - Biome para lint/format (mesmo do portal)

2. **Configurar Vitest workspaces**
   - `vitest.config.ts` + `vitest.workspace.ts` (unit, integration, e2e)
   - `tests/helpers/setup.ts` (env vars de teste)

3. **Criar `sql/schema.sql`**
   - Todas as tabelas `ap_*` do plano de arquitetura
   - Incluir índices e constraints

4. **Criar Dockerfile**
   - Multi-stage build (build TS → run Node)
   - `NODE_TYPE` env var para web/worker mode

5. **Criar `docker-compose.yml`** (dev local)
   - Postgres 15 + volume com schema

6. **Criar `docker-compose.e2e.yml`**
   - Postgres + federation-server + federation-worker + GoToSocial

7. **Verificação**: `pnpm test:unit` roda (0 tests), `pnpm build` compila

### Entregável
Repo vazio mas funcional: compila, lint passa, vitest roda, Docker builda.

---

## Fase 1: Schema + Camada de Dados

**Objetivo**: Tabelas Postgres validadas por testes de integração + módulo `db.ts` com funções CRUD.

### Módulo 1.1: Schema SQL + Integration Tests

**Testes primeiro** (contra Postgres real via testcontainers):

1. Escrever `tests/helpers/db.ts` (setup/teardown do container Postgres)
2. Escrever `tests/helpers/fixtures.ts` (dados de teste)
3. Escrever `tests/integration/db-actors.test.ts`
4. Escrever `tests/integration/db-followers.test.ts`
5. Escrever `tests/integration/db-publish-queue.test.ts`
6. Escrever `tests/integration/db-delivery-log.test.ts`
7. Escrever `tests/integration/db-dead-servers.test.ts`

**Depois o código**:

8. Implementar `src/db.ts` — connection pool + funções CRUD:
   - `getActorByIdentifier()`, `getActiveFollowers()`, `insertFollower()`, `removeFollower()`
   - `getPendingPublishQueue()`, `markPublished()`, `markFailed()`
   - `insertActivity()`, `insertDeliveryLog()`, `recordServerFailure()`
   - `isServerDead()`, `getDeadServersForProbe()`

9. **Rodar**: `pnpm test:integration` — todos passam

### Módulo 1.2: Key Management

**Testes primeiro** (unit, sem I/O):

1. Escrever `tests/unit/keys.test.ts`
   - Geração RSA-2048 → export JWK → import → roundtrip
   - Geração Ed25519 → export JWK → import → roundtrip
   - Sign + verify com chave gerada

**Depois o código**:

2. Implementar `src/keys.ts`
   - `generateRsaKeyPair()`, `generateEd25519KeyPair()`
   - `exportKeyPairToJwk()`, `importKeyPairFromJwk()`

3. **Rodar**: `pnpm test:unit` — keys tests passam

### Módulo 1.3: Scripts de Seed

1. Implementar `scripts/seed-actors.ts`
   - Lê `agencies.yaml` + `themes.yaml` (copiados ou referenciados do portal)
   - Gera chaves RSA + Ed25519 para cada actor
   - Insere 182 actors na tabela `ap_actors`

2. Implementar `scripts/generate-keys.ts` (re-geração de chaves se necessário)

3. **Verificação**: Rodar seed contra Postgres local, verificar 182 actors no banco

### Entregável Fase 1
- Schema validado por ~35 testes de integração
- Camada de dados (`db.ts`) com CRUD completo
- Key management testado unitariamente
- Script de seed funcional

---

## Fase 2: Fedify Core + Actor Profiles

**Objetivo**: Servidor responde WebFinger e serve perfis de actors.

### Módulo 2.1: Federation Setup

**Explorar primeiro**: Ler docs do Fedify sobre `createFederation`, `PostgresKvStore`, `PostgresMessageQueue`.

1. Escrever `tests/helpers/federation.ts` (factory com MemoryKvStore + InProcessMessageQueue)

2. Implementar `src/federation.ts`
   - `createFederation()` com PostgresKvStore/Queue (prod) ou Memory/InProcess (test)
   - Configurar `manuallyStartQueue` baseado em `NODE_TYPE`

3. Escrever `tests/integration/fedify-postgres-kv.test.ts`
4. Escrever `tests/integration/fedify-postgres-queue.test.ts`
5. **Rodar**: integration tests passam

### Módulo 2.2: Actor Dispatcher

**Testes primeiro** (unit):

1. Escrever `tests/unit/actors.test.ts`
   - Organization para agency, Group para tema, Application para portal
   - Null para inexistente
   - URIs corretas (inbox, outbox, followers)
   - publicKey presente

**Depois o código**:

2. Implementar `src/actors.ts`
   - `setActorDispatcher`: consulta `ap_actors` via `db.ts`, retorna actor Fedify
   - `setKeyPairsDispatcher`: carrega JWK do banco, converte para CryptoKeyPair

3. **Rodar**: `pnpm test:unit` — actors tests passam

### Módulo 2.3: WebFinger

**Testes primeiro** (unit, testando via Hono app.request):

1. Escrever `tests/unit/webfinger.test.ts`
   - JRD correto para acct:portal@domain, acct:agricultura@domain, acct:tema-01@domain
   - 404 para inexistente, 400 para resource inválido

**Depois o código**:

2. Implementar WebFinger (Fedify configura automaticamente, mas validar)

3. **Rodar**: `pnpm test:unit` — webfinger tests passam

### Módulo 2.4: Hono App + Routes

**Testes primeiro** (unit):

1. Escrever `tests/unit/routes/health.test.ts`

**Depois o código**:

2. Implementar `src/index.ts` — Hono app com federation middleware + health route
3. **Rodar**: `pnpm test:unit` — health tests passam

### Verificação end-to-end da Fase 2

```bash
# Subir localmente
docker compose up -d
pnpm dev

# Testar WebFinger
curl -s "http://localhost:3000/.well-known/webfinger?resource=acct:agricultura@localhost:3000"

# Testar Actor profile
curl -s -H "Accept: application/activity+json" "http://localhost:3000/ap/actors/agricultura"
```

### Entregável Fase 2
- Federation configurada com Fedify
- 182 actors resolvíveis via WebFinger
- Perfis JSON-LD com chaves públicas
- ~15 novos testes (unit + integration)

---

## Fase 3: Inbox (Follow/Accept)

**Objetivo**: Aceitar follows do fediverso, persistir seguidores.

### Módulo 3.1: Inbox Handlers

**Testes primeiro** (unit):

1. Escrever `tests/unit/inbox.test.ts`
   - Follow → accept + armazena follower
   - Undo{Follow} → remove follower
   - Rejeita activities inválidas

**Depois o código**:

2. Implementar `src/inbox.ts`
   - `setInboxListeners` com handlers para Follow e Undo
   - Follow: verificar assinatura (automático), extrair follower info, inserir em `ap_followers`, enviar Accept
   - Undo{Follow}: marcar follower como removed

3. **Rodar**: `pnpm test:unit` — inbox tests passam

### Módulo 3.2: Followers Collection

**Testes primeiro** (unit):

1. Adicionar testes em `tests/unit/outbox.test.ts` para followers collection dispatcher

**Depois o código**:

2. Configurar `setFollowersDispatcher` no Fedify

3. **Rodar**: tests passam

### Verificação: Testar follow real (se Load Balancer disponível)

Se o LB + domínio já estiverem configurados:
- Testar follow de conta Mastodon real
- Senão: testar com `fedify tunnel` para expor servidor local

### Entregável Fase 3
- Follow/Accept funcional
- Seguidores persistidos no Postgres
- ~7 novos testes unit

---

## Fase 4: Pipeline de Publicação

**Objetivo**: Artigos são convertidos em Activities e entregues a seguidores.

### Módulo 4.1: Article Builder

**Testes primeiro** (unit):

1. Escrever `tests/unit/article-builder.test.ts`
   - Conversão news row → Article ActivityPub
   - Campos: name, content (HTML), summary, image, tags, url
   - Activity URI (ULID), to/cc addressing

**Depois o código**:

2. Implementar `src/article-builder.ts`
   - `buildArticleActivity(newsRow, actorIdentifier, domain)` → Create{Article}

3. **Rodar**: `pnpm test:unit` — article-builder tests passam

### Módulo 4.2: Publisher

**Testes primeiro** (unit):

1. Escrever `tests/unit/publisher.test.ts`
   - Processa publish_queue pendente
   - Chama sendActivity com actor/activity corretos
   - Marca published/failed corretamente

**Testes primeiro** (unit para route):

2. Escrever `tests/unit/routes/trigger-publish.test.ts`
   - Auth (token válido/inválido/ausente)
   - Retorna contagem processada

**Depois o código**:

3. Implementar `src/publisher.ts`
   - `processPublishQueue(ctx, limit)`: lê ap_publish_queue, constrói activities, chama sendActivity
   - Route handler `POST /trigger-publish`

4. **Rodar**: `pnpm test:unit` — publisher tests passam

### Módulo 4.3: Worker Mode

1. Implementar lógica de worker em `src/index.ts`
   - Se `NODE_TYPE=worker`: chama `federation.startQueue()`
   - Health check endpoint

### Módulo 4.4: Integration Test — Full Publish Flow

1. Escrever `tests/integration/full-publish-flow.test.ts`
   - Seed actors + followers → insert publish_queue → processQueue → verificar estado

2. **Rodar**: `pnpm test:integration` — full flow passa

### Módulo 4.5: Outbox

**Testes primeiro** (unit):

1. Escrever `tests/unit/outbox.test.ts`
   - OrderedCollection vazia, paginação, ordem cronológica

**Depois o código**:

2. Implementar `src/outbox.ts` — `setOutboxDispatcher`

3. **Rodar**: `pnpm test:unit` — outbox tests passam

### Entregável Fase 4
- Pipeline completo: publish_queue → sendActivity → fedify queue → delivery
- Article builder testado
- Publisher testado (unit + integration)
- Worker mode funcional
- ~20 novos testes

---

## Fase 5: Dead Servers + Resiliência

**Objetivo**: Lidar com servidores que falham permanentemente.

### Módulo 5.1: Dead Server Detection

**Testes primeiro** (unit):

1. Escrever `tests/unit/dead-servers.test.ts`
   - Threshold de 50 falhas, isServerDead, reset para probe

**Depois o código**:

2. Implementar `src/dead-servers.ts`
   - `recordFailure()`, `isServerDead()`, `getServersForProbe()`, `resetProbe()`

3. **Rodar**: `pnpm test:unit` — dead-servers tests passam

### Entregável Fase 5
- Dead server detection funcional
- ~6 novos testes unit

---

## Fase 6: Airflow DAG

**Objetivo**: DAG que detecta artigos novos e alimenta a publish_queue.

1. Implementar `dags/detect_new_articles_for_federation.py`
   - Task 1: detect_new_articles (query news, insert publish_queue)
   - Task 2: trigger_federation_publish (POST /trigger-publish)

2. Testar localmente contra Postgres de dev

3. Configurar GitHub Actions para deploy da DAG no Cloud Composer

### Entregável Fase 6
- DAG funcional, deployável no Cloud Composer

---

## Fase 7: E2E Tests

**Objetivo**: Validar o sistema completo com um servidor ActivityPub real.

1. Implementar `tests/helpers/gotosocial.ts` (client)

2. Escrever `tests/e2e/discovery.test.ts`
   - WebFinger, actor profiles, NodeInfo

3. Escrever `tests/e2e/follow-accept.test.ts`
   - Follow completo via GoToSocial → Accept → ap_followers

4. Escrever `tests/e2e/publish-receive.test.ts`
   - Publicação → delivery → artigo na timeline do GoToSocial

5. **Rodar**: `docker compose -f docker-compose.e2e.yml up -d --wait && pnpm test:e2e`

### Entregável Fase 7
- ~10 testes e2e validando fluxos reais
- CI pipeline com 3 jobs (unit, integration, e2e)

---

## Fase 8: Terraform + Deploy

**Objetivo**: Infra no GCP.

1. `infra/terraform/federation.tf` — Cloud Run web + worker
2. `infra/terraform/load_balancer.tf` — HTTPS LB com URL routing
3. `infra/terraform/secrets.tf` — federation-auth-token
4. GitHub Actions workflow para build + deploy
5. DNS: apontar destaques.gov.br para o LB

### Entregável Fase 8
- Serviço em produção, acessível via `destaques.gov.br/ap/*`

---

## Fase 9: Monitoramento + Polish

1. Métricas customizadas no Cloud Monitoring
2. Alertas
3. Pruning jobs (Airflow)
4. NodeInfo endpoint
5. Ícones dos actors
6. Support para Update{Article}
7. Documentação

---

## Resumo de Testes por Fase

| Fase | Unit | Integration | E2E | Total |
|------|------|-------------|-----|-------|
| 0: Scaffold | 0 | 0 | 0 | 0 |
| 1: Schema + Dados | 4 | 35 | 0 | 39 |
| 2: Fedify + Actors | 10 | 6 | 0 | 16 |
| 3: Inbox | 7 | 0 | 0 | 7 |
| 4: Publicação | 20 | 1 | 0 | 21 |
| 5: Dead Servers | 6 | 0 | 0 | 6 |
| 6: DAG | 0 | 0 | 0 | 0 |
| 7: E2E | 0 | 0 | 10 | 10 |
| **Total** | **~47** | **~42** | **~10** | **~99** |
