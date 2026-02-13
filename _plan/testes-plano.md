# Plano de Testes — activitypub-server

## Contexto

O repositório `destaquesgovbr/activitypub-server` implementa um servidor ActivityPub com Fedify + Hono + PostgreSQL. Antes de implementar a aplicação, precisamos estruturar a suite de testes para garantir cobertura desde o início. A estratégia cobre 3 camadas: unit, integration (com Postgres real) e e2e (com um cliente ActivityPub real verificando recebimento de posts).

---

## Stack de Testes

| Ferramenta | Função |
|---|---|
| **Vitest** | Test runner + assertions |
| **@fedify/testing** | `MockFederation`, `MockContext` — mocks oficiais do Fedify |
| **MemoryKvStore** | KV store in-memory do Fedify (substitui PostgresKvStore em unit tests) |
| **InProcessMessageQueue** | Message queue síncrona do Fedify (substitui PostgresMessageQueue em unit tests) |
| **@testcontainers/postgresql** | Sobe Postgres em Docker automaticamente para integration tests |
| **hono/testing** | Helpers para testar Hono app (via `app.request()`) |
| **GoToSocial** (Docker) | Servidor AP leve para e2e — atua como "Mastodon" nos testes |
| **docker-compose** | Orquestra Postgres + server + GoToSocial para e2e |

---

## Estrutura de Diretórios

```
activitypub-server/
├── vitest.config.ts                    # Config com workspaces (unit, integration, e2e)
├── docker-compose.yml                  # Dev local: postgres + server
├── docker-compose.test.yml             # CI: postgres para integration tests
├── docker-compose.e2e.yml              # E2E: postgres + server + gotosocial
├── sql/
│   └── schema.sql                      # Schema completo (tabelas ap_*)
├── src/
│   └── ...                             # Código da aplicação
└── tests/
    ├── helpers/
    │   ├── setup.ts                    # Setup global (env vars, etc.)
    │   ├── db.ts                       # Helpers para Postgres em integration tests
    │   ├── federation.ts               # Factory: cria MockFederation configurada
    │   ├── fixtures.ts                 # Dados de teste (actors, articles, activities)
    │   └── gotosocial.ts               # Client helper para interagir com GoToSocial no e2e
    ├── unit/
    │   ├── actors.test.ts
    │   ├── inbox.test.ts
    │   ├── outbox.test.ts
    │   ├── publisher.test.ts
    │   ├── article-builder.test.ts
    │   ├── keys.test.ts
    │   ├── dead-servers.test.ts
    │   ├── webfinger.test.ts
    │   └── routes/
    │       ├── health.test.ts
    │       └── trigger-publish.test.ts
    ├── integration/
    │   ├── db-actors.test.ts
    │   ├── db-followers.test.ts
    │   ├── db-publish-queue.test.ts
    │   ├── db-delivery-log.test.ts
    │   ├── db-dead-servers.test.ts
    │   ├── fedify-postgres-kv.test.ts
    │   ├── fedify-postgres-queue.test.ts
    │   └── full-publish-flow.test.ts
    └── e2e/
        ├── discovery.test.ts
        ├── follow-accept.test.ts
        └── publish-receive.test.ts
```

---

## Vitest Config (workspaces)

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Workspace-based: cada tipo de teste tem config separada
  },
})
```

```typescript
// vitest.workspace.ts
export default [
  {
    test: {
      name: 'unit',
      include: ['tests/unit/**/*.test.ts'],
      environment: 'node',
      setupFiles: ['tests/helpers/setup.ts'],
      // Roda em paralelo, sem dependências externas
    },
  },
  {
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.test.ts'],
      environment: 'node',
      setupFiles: ['tests/helpers/setup.ts'],
      pool: 'forks',        // Isolamento por processo (testcontainers)
      poolOptions: { forks: { singleFork: true } },  // Sequencial (1 container PG)
      testTimeout: 30_000,   // Testcontainers precisa de mais tempo
    },
  },
  {
    test: {
      name: 'e2e',
      include: ['tests/e2e/**/*.test.ts'],
      environment: 'node',
      setupFiles: ['tests/helpers/setup.ts'],
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
      testTimeout: 60_000,   // Federation é lento
    },
  },
]
```

---

## 1. Unit Tests

**Princípio**: Sem I/O. Sem Docker. Sem rede. Rápidos (<5s total).

Usam `MockFederation` + `MemoryKvStore` + `InProcessMessageQueue` do Fedify.

### `tests/helpers/federation.ts` — Factory de teste

```typescript
import { MemoryKvStore, InProcessMessageQueue } from '@fedify/fedify'
// Importar MockFederation de @fedify/testing quando disponível,
// ou usar createFederation com MemoryKvStore como mock funcional

export function createTestFederation() {
  const kv = new MemoryKvStore()
  const queue = new InProcessMessageQueue()
  // createFederation com kv/queue in-memory
  // Registrar os mesmos dispatchers da app real
  return { federation, kv, queue }
}
```

### `tests/helpers/fixtures.ts` — Dados de teste

```typescript
export const TEST_ACTORS = {
  portal: { identifier: 'portal', actor_type: 'portal', display_name: 'Destaques GOV.BR' },
  agricultura: { identifier: 'agricultura', actor_type: 'agency', agency_key: 'agricultura', display_name: 'Min. Agricultura' },
  tema01: { identifier: 'tema-01', actor_type: 'theme', theme_code: '01', display_name: 'Economia e Finanças' },
}

export const TEST_ARTICLES = {
  basic: { unique_id: 'abc123', title: 'Teste', content: '# Markdown', agency_key: 'agricultura', theme_l1_code: '01', published_at: Date.now() },
}

export const TEST_FOLLOW_ACTIVITY = { /* Follow JSON-LD */ }
export const TEST_UNDO_FOLLOW_ACTIVITY = { /* Undo{Follow} JSON-LD */ }
```

### Testes unitários por módulo

#### `tests/unit/actors.test.ts`
- Actor dispatcher retorna Organization para agency actor
- Actor dispatcher retorna Group para theme actor
- Actor dispatcher retorna Application para portal actor
- Actor dispatcher retorna null para identifier inexistente
- Actor inclui publicKey no JSON-LD
- Actor inclui inbox/outbox/followers URIs corretas
- preferredUsername corresponde ao identifier

#### `tests/unit/inbox.test.ts`
- Follow handler chama accept e armazena follower
- Follow handler extrai shared_inbox_uri do actor remoto
- Follow handler extrai server hostname do follower_uri
- Undo{Follow} remove follower (status='removed')
- Undo{Follow} para follower inexistente não falha
- Inbox rejeita activity sem actor válido
- Inbox rejeita activity com tipo não suportado

#### `tests/unit/outbox.test.ts`
- Outbox retorna OrderedCollection vazia para actor sem atividades
- Outbox pagina corretamente (first/next links)
- Outbox retorna atividades em ordem cronológica reversa
- Outbox respeita limite de items por página

#### `tests/unit/publisher.test.ts`
- Processa entradas pendentes da publish_queue
- Chama sendActivity para cada entrada com actor correto
- Marca entrada como 'published' após sucesso
- Marca entrada como 'failed' com error_message em caso de erro
- Pula entradas cujo actor não tem followers (noop)
- Respeita LIMIT no batch

#### `tests/unit/article-builder.test.ts`
- Constrói Article com type='Article'
- Mapeia title para name
- Mapeia content (markdown) para HTML no content
- Mapeia summary
- Mapeia image para attachment Image
- Mapeia tags para Hashtag objects
- Gera URL canônica do artigo
- Gera activity URI única (ULID)
- Define to=Public e cc=followers

#### `tests/unit/keys.test.ts`
- Gera par RSA-2048 e exporta como JWK
- Gera par Ed25519 e exporta como JWK
- Importa JWK de volta para CryptoKeyPair
- Roundtrip: generate → export → import → sign → verify

#### `tests/unit/dead-servers.test.ts`
- Incrementa consecutive_failures no registro
- Marca como dead após 50 falhas
- Não marca como dead com menos de 50 falhas
- isServerDead retorna true para servidor morto
- isServerDead retorna false para servidor saudável
- Reseta servidor para probe quando next_probe_at atingido

#### `tests/unit/webfinger.test.ts`
- Retorna JRD correto para acct:portal@domain
- Retorna JRD correto para acct:agricultura@domain
- Retorna JRD correto para acct:tema-01@domain
- Retorna 404 para actor inexistente
- Retorna 400 para resource sem prefixo acct:
- Link 'self' aponta para URI do actor com type application/activity+json

#### `tests/unit/routes/health.test.ts`
- GET /health retorna 200
- Retorna JSON com status

#### `tests/unit/routes/trigger-publish.test.ts`
- POST /trigger-publish com token válido retorna 200
- POST /trigger-publish sem token retorna 401
- POST /trigger-publish com token inválido retorna 403
- Retorna contagem de itens processados no body

---

## 2. Integration Tests (PostgreSQL real)

**Princípio**: Testam operações de banco reais. Usam `@testcontainers/postgresql` para criar um container Postgres temporário no CI. Schema é aplicado via `sql/schema.sql`.

### `tests/helpers/db.ts` — Setup do container

```typescript
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres from 'postgres'
import { readFileSync } from 'fs'
import { join } from 'path'

let container: StartedPostgreSqlContainer
let sql: ReturnType<typeof postgres>

export async function setupTestDatabase() {
  container = await new PostgreSqlContainer('postgres:15')
    .withDatabase('govbrnews_test')
    .start()

  sql = postgres(container.getConnectionString())

  // Aplica schema
  const schema = readFileSync(join(__dirname, '../../sql/schema.sql'), 'utf-8')
  await sql.unsafe(schema)

  return { sql, connectionString: container.getConnectionString() }
}

export async function teardownTestDatabase() {
  await sql.end()
  await container.stop()
}

export async function cleanTables() {
  await sql`TRUNCATE ap_publish_queue, ap_delivery_log, ap_activities, ap_followers, ap_dead_servers RESTART IDENTITY CASCADE`
}

export { sql }
```

### Testes de integração por tabela/fluxo

#### `tests/integration/db-actors.test.ts`
- INSERT actor e SELECT por identifier
- INSERT actor com chaves RSA/Ed25519 JWK e recupera corretamente
- UNIQUE constraint impede identifier duplicado
- CHECK constraint rejeita actor_type inválido
- Filtra actors por actor_type
- is_active default é true

#### `tests/integration/db-followers.test.ts`
- INSERT follower e SELECT por actor_id
- UNIQUE constraint impede follow duplicado (actor_id + follower_uri)
- UPDATE status para 'removed' (unfollow)
- SELECT apenas followers ativos (WHERE status='active')
- Filtra por follower_server
- CASCADE delete: remover actor remove followers

#### `tests/integration/db-publish-queue.test.ts`
- INSERT entrada e SELECT pendentes
- UNIQUE constraint impede (news_unique_id + actor_identifier) duplicado
- ON CONFLICT DO NOTHING é idempotente
- UPDATE status pending → processing → published
- UPDATE status pending → failed com error_message
- Índice parcial: SELECT WHERE status='pending' ORDER BY queued_at
- Contagem correta de pendentes

#### `tests/integration/db-delivery-log.test.ts`
- INSERT log de entrega com status success
- INSERT log de entrega com status failed + http_status_code
- UPDATE attempt_count e next_retry_at
- Aggregate query: taxa de sucesso por servidor
- CASCADE delete: remover activity remove delivery logs

#### `tests/integration/db-dead-servers.test.ts`
- INSERT servidor com falha inicial
- UPDATE incrementa consecutive_failures
- UPDATE marca is_dead=true quando >= 50
- SELECT servidores mortos
- UPDATE reseta para probe (is_dead=false, next_probe_at)

#### `tests/integration/fedify-postgres-kv.test.ts`
- PostgresKvStore set/get roundtrip
- PostgresKvStore delete
- PostgresKvStore com múltiplas chaves

#### `tests/integration/fedify-postgres-queue.test.ts`
- PostgresMessageQueue enqueue/dequeue
- Mensagem é processada pelo consumer
- Retry após falha

#### `tests/integration/full-publish-flow.test.ts`
- **Fluxo completo com Postgres real**:
  1. Seed actors na tabela ap_actors
  2. Seed followers na tabela ap_followers
  3. INSERT artigo na ap_publish_queue
  4. Chamar publisher.processQueue()
  5. Verificar que ap_publish_queue.status = 'published'
  6. Verificar que ap_activities tem nova entrada
  7. Verificar que sendActivity foi chamado (mock do HTTP outbound)

---

## 3. E2E Tests (Docker Compose)

**Princípio**: Sobe o ecossistema completo com docker-compose. Um servidor GoToSocial atua como "Mastodon" para receber e verificar atividades.

### `docker-compose.e2e.yml`

```yaml
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: govbrnews_test
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
    ports:
      - "5433:5432"
    volumes:
      - ./sql/schema.sql:/docker-entrypoint-initdb.d/01-schema.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U test -d govbrnews_test"]
      interval: 2s
      timeout: 5s
      retries: 10

  federation-server:
    build: .
    environment:
      NODE_TYPE: web
      DATABASE_URL: postgres://test:test@postgres:5432/govbrnews_test
      AP_DOMAIN: federation-server:3000
      FEDERATION_AUTH_TOKEN: test-token-e2e
    ports:
      - "3000:3000"
    depends_on:
      postgres:
        condition: service_healthy

  federation-worker:
    build: .
    environment:
      NODE_TYPE: worker
      DATABASE_URL: postgres://test:test@postgres:5432/govbrnews_test
      AP_DOMAIN: federation-server:3000
    depends_on:
      postgres:
        condition: service_healthy

  gotosocial:
    image: superseriousbusiness/gotosocial:latest
    environment:
      GTS_HOST: gotosocial:8080
      GTS_DB_TYPE: sqlite
      GTS_DB_ADDRESS: /gotosocial/storage/sqlite.db
      GTS_STORAGE_LOCAL_BASE_PATH: /gotosocial/storage
      GTS_LETSENCRYPT_ENABLED: "false"
      GTS_ACCOUNTS_REGISTRATION_OPEN: "true"
    ports:
      - "8080:8080"
    volumes:
      - gotosocial-data:/gotosocial/storage
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8080/nodeinfo/2.0"]
      interval: 5s
      timeout: 10s
      retries: 10

volumes:
  gotosocial-data:
```

### `tests/helpers/gotosocial.ts` — Client para GoToSocial

```typescript
// Helper para interagir com GoToSocial via API
// - Criar conta de teste
// - Obter token OAuth
// - Enviar Follow para nosso servidor
// - Verificar timeline (artigos recebidos)

export class GoToSocialClient {
  constructor(private baseUrl: string) {}

  async createAccount(username: string, email: string, password: string): Promise<void> { ... }
  async getToken(email: string, password: string): Promise<string> { ... }
  async follow(token: string, actorUri: string): Promise<void> { ... }
  async getTimeline(token: string): Promise<Activity[]> { ... }
  async searchAccount(token: string, query: string): Promise<Account | null> { ... }
}
```

### Testes E2E

#### `tests/e2e/discovery.test.ts`
- WebFinger para @portal@federation-server:3000 retorna actor URI
- WebFinger para @agricultura@federation-server:3000 retorna actor URI
- GET actor URI com Accept: application/activity+json retorna JSON-LD
- Actor JSON-LD contém publicKey, inbox, outbox, followers
- NodeInfo endpoint retorna metadata do servidor

#### `tests/e2e/follow-accept.test.ts`
- **Fluxo completo de follow**:
  1. Seed actor 'portal' no Postgres (com chaves RSA)
  2. Criar conta no GoToSocial
  3. Buscar @portal@federation-server:3000 no GoToSocial
  4. Seguir o actor
  5. Verificar que ap_followers tem nova entrada
  6. Verificar que GoToSocial mostra o follow como aceito
- **Unfollow**:
  1. Desfazer follow no GoToSocial
  2. Verificar que ap_followers.status = 'removed'

#### `tests/e2e/publish-receive.test.ts`
- **Fluxo completo de publicação**:
  1. Seed actor + followers (GoToSocial seguindo nosso actor)
  2. INSERT artigo na ap_publish_queue
  3. POST /trigger-publish
  4. Aguardar worker processar a fila (poll fedify_message_v2)
  5. Verificar na timeline do GoToSocial que o artigo apareceu
  6. Verificar que o artigo tem title, content, url corretos

---

## CI Pipeline (GitHub Actions)

```yaml
# .github/workflows/test.yml
name: Tests
on: [push, pull_request]

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:unit

  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: pnpm install --frozen-lockfile
      # Testcontainers usa Docker do runner (pre-instalado no ubuntu-latest)
      - run: pnpm test:integration

  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: pnpm install --frozen-lockfile
      - run: docker compose -f docker-compose.e2e.yml up -d --wait
      - run: pnpm test:e2e
      - run: docker compose -f docker-compose.e2e.yml down -v
        if: always()
```

### Scripts no package.json

```json
{
  "scripts": {
    "test": "vitest run",
    "test:unit": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "test:e2e": "vitest run --project e2e",
    "test:watch": "vitest --project unit"
  }
}
```

---

## Dependências de teste (devDependencies)

```json
{
  "@fedify/testing": "^1.x",
  "vitest": "^3.x",
  "@testcontainers/postgresql": "^10.x",
  "testcontainers": "^10.x"
}
```

---

## Verificação

```bash
# Unit tests (sem Docker, <5s)
pnpm test:unit

# Integration tests (sobe Postgres via testcontainers, ~30s)
pnpm test:integration

# E2E tests (docker-compose completo, ~2min)
docker compose -f docker-compose.e2e.yml up -d --wait
pnpm test:e2e
docker compose -f docker-compose.e2e.yml down -v
```
