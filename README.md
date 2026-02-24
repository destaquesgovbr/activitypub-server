# ActivityPub Federation Server

Servidor ActivityPub para o portal Destaques GOV.BR. Transmite notícias do governo federal brasileiro para o Fediverse (Mastodon, Lemmy, etc.) via protocolo ActivityPub.

## Arquitetura

```
┌─────────────────────────────────────────────┐
│           Airflow DAG (futuro)              │
│    Preenche ap_publish_queue com notícias   │
└──────────────────┬──────────────────────────┘
                   │ POST /trigger-publish
                   ▼
┌─────────────────────────────────────────────┐
│    ActivityPub Federation Server (Node.js)  │
│                                             │
│  WEB (público, scale-to-zero 0→5)          │
│  ├─ GET  /.well-known/webfinger            │
│  ├─ GET  /ap/actors/{id}                   │
│  ├─ GET  /ap/actors/{id}/outbox            │
│  ├─ GET  /ap/actors/{id}/followers         │
│  ├─ POST /ap/actors/{id}/inbox             │
│  ├─ POST /ap/inbox  (shared inbox)         │
│  ├─ POST /trigger-publish                  │
│  └─ GET  /health                           │
│                                             │
│  WORKER (interno, always-on 1→2)           │
│  └─ Processa fila de mensagens Fedify      │
│                                             │
│  Cloud SQL PostgreSQL (database: federation)│
│  └─ 185 atores (1 portal + 159 órgãos +   │
│     25 temas)                               │
└─────────────────────────────────────────────┘
         │ Create{Article}
         ▼
┌─────────────────────────────────────────────┐
│   Fediverse (servidores remotos)            │
│   Mastodon, Lemmy, Misskey, GoToSocial...  │
└─────────────────────────────────────────────┘
```

**Stack:** Fedify 1.10 + Hono + PostgreSQL + Cloud Run

## Desenvolvimento Local

### Pré-requisitos

- Node.js >= 22
- pnpm
- Docker (para PostgreSQL local e testes de integração)

### Setup

```bash
# Instalar dependências
pnpm install

# Subir PostgreSQL local (porta 5433)
docker compose up -d

# Rodar seed de atores (gera chaves e insere 185 atores)
DATABASE_URL=postgres://federation:federation@localhost:5433/federation pnpm seed

# Iniciar servidor em modo dev (hot reload)
DATABASE_URL=postgres://federation:federation@localhost:5433/federation \
AP_DOMAIN=localhost:3000 \
FEDERATION_AUTH_TOKEN=test-token \
NODE_TYPE=web \
pnpm dev
```

### Variáveis de Ambiente

| Variável | Descrição | Exemplo |
|----------|-----------|---------|
| `DATABASE_URL` | Connection string PostgreSQL | `postgres://user:pass@host:5432/db` |
| `NODE_TYPE` | Tipo do nó: `web` ou `worker` | `web` |
| `AP_DOMAIN` | Domínio ActivityPub (sem protocolo) | `federation.destaquesgovbr.org` |
| `FEDERATION_AUTH_TOKEN` | Token para `/trigger-publish` | (gerado pelo Terraform) |
| `NODE_ENV` | Ambiente | `production` / `test` |
| `PORT` | Porta HTTP (padrão: 3000) | `3000` |

## Testes

```bash
# Todos os testes
pnpm test

# Unitários (rápidos, sem banco)
pnpm test:unit

# Integração (usa testcontainers ou TEST_DATABASE_URL)
pnpm test:integration

# E2E (docker compose com GoToSocial)
docker compose -f docker-compose.e2e.yml up -d
pnpm test:e2e

# Watch mode (unitários)
pnpm test:watch
```

### Estrutura de Testes

```
tests/
├── unit/           # Mocks, sem I/O externo
├── integration/    # Testcontainers (PostgreSQL real)
├── e2e/            # Full stack + GoToSocial
└── helpers/        # Fixtures, setup, factory
```

## Banco de Dados

### Schema

O schema está em `sql/schema.sql`. Tabelas:

| Tabela | Descrição |
|--------|-----------|
| `ap_actors` | 185 atores ActivityPub (portal, órgãos, temas) com chaves RSA/Ed25519 |
| `ap_followers` | Contas remotas que seguem nossos atores |
| `ap_publish_queue` | Fila de publicação (preenchida pelo Airflow, consumida pelo `/trigger-publish`) |
| `ap_activities` | Log de atividades publicadas |
| `ap_delivery_log` | Log de entrega por inbox com retry |
| `ap_dead_servers` | Servidores remotos permanentemente inacessíveis |
| `ap_sync_watermark` | Checkpoint do Airflow DAG (singleton) |

### Aplicar schema e seed (produção)

```bash
# Pegar a connection string do Secret Manager
FEDERATION_DB_URL=$(gcloud secrets versions access latest \
  --secret=federation-database-url --project=inspire-7-finep)

# Aplicar schema
psql "$FEDERATION_DB_URL" -f sql/schema.sql

# Seed de atores (precisa dos YAMLs de agencies e themes no mesmo workspace)
DATABASE_URL="$FEDERATION_DB_URL" pnpm seed
```

## Deploy (Produção)

### Infraestrutura (Terraform)

A infra é gerenciada pelo repo `destaquesgovbr/infra`:

| Recurso | Descrição |
|---------|-----------|
| Cloud SQL database `federation` | Banco no Cloud SQL instance existente (`destaquesgovbr-postgres`) |
| Secret Manager `federation-database-url` | Connection string PostgreSQL |
| Secret Manager `federation-auth-token` | Token para `/trigger-publish` |
| Service Account `destaquesgovbr-federation` | SA dos Cloud Run services |
| Artifact Registry `destaquesgovbr-federation` | Repositório Docker |
| Cloud Run `destaquesgovbr-federation-web` | Serviço web (público, scale-to-zero) |
| Cloud Run `destaquesgovbr-federation-worker` | Worker (interno, always-on) |

Arquivo principal: `infra/terraform/federation.tf`

### CI/CD (GitHub Actions)

Push para `main` dispara:

1. **test.yml** — unit tests, integration tests, lint, build
2. **deploy.yml** — build Docker, push Artifact Registry, deploy web + worker

Autenticação: Workload Identity Federation (OIDC, sem JSON keys).

Secrets necessários no repo `activitypub-server`:
- `GCP_WORKLOAD_IDENTITY_PROVIDER` — ID do Workload Identity Provider
- `GCP_SERVICE_ACCOUNT` — Email da SA do GitHub Actions

### Deploy manual (emergência)

```bash
# Build da imagem
docker buildx build \
  --platform linux/amd64 \
  --provenance=false --sbom=false \
  -t southamerica-east1-docker.pkg.dev/inspire-7-finep/destaquesgovbr-federation/server:latest \
  .

# Push
gcloud auth configure-docker southamerica-east1-docker.pkg.dev
docker push southamerica-east1-docker.pkg.dev/inspire-7-finep/destaquesgovbr-federation/server:latest

# Deploy web
gcloud run deploy destaquesgovbr-federation-web \
  --image southamerica-east1-docker.pkg.dev/inspire-7-finep/destaquesgovbr-federation/server:latest \
  --region southamerica-east1 --project inspire-7-finep --quiet

# Deploy worker
gcloud run deploy destaquesgovbr-federation-worker \
  --image southamerica-east1-docker.pkg.dev/inspire-7-finep/destaquesgovbr-federation/server:latest \
  --region southamerica-east1 --project inspire-7-finep --quiet
```

> **Importante:** Use `--provenance=false --sbom=false` no build. Sem essas flags, o Docker Buildx gera manifests OCI com attestation que o Cloud Run não consegue parsear ("image not found").

### URLs de Produção

| Serviço | URL |
|---------|-----|
| Web | https://destaquesgovbr-federation-web-990583792367.southamerica-east1.run.app |
| Worker | https://destaquesgovbr-federation-worker-990583792367.southamerica-east1.run.app |

### Verificar saúde

```bash
# Health check
curl https://destaquesgovbr-federation-web-990583792367.southamerica-east1.run.app/health

# WebFinger
curl "https://destaquesgovbr-federation-web-990583792367.southamerica-east1.run.app/.well-known/webfinger?resource=acct:portal@destaquesgovbr-federation-web-990583792367.southamerica-east1.run.app"

# Actor profile
curl -H "Accept: application/activity+json" \
  https://destaquesgovbr-federation-web-990583792367.southamerica-east1.run.app/ap/actors/portal

# Logs
gcloud logging read 'resource.type="cloud_run_revision" resource.labels.service_name="destaquesgovbr-federation-web"' \
  --project=inspire-7-finep --limit=20 --format='table(timestamp,textPayload)'
```

## Troubleshooting

### DATABASE_URL com caracteres especiais

Se o `random_password` do Terraform gerar caracteres como `?`, `@`, `#`, a URL de conexão quebra (o parser interpreta `?` como query string). Solução:
- Usar `special = false` no `random_password`
- Usar `urlencode()` no password dentro do `format()`

### Cloud Run "Image not found"

Docker Buildx com `--provenance=true` (padrão) gera manifests OCI com attestation. Cloud Run não suporta. Use:
```bash
docker buildx build --provenance=false --sbom=false ...
```

### Worker fails on startup (DNS error)

O worker chama `fedi.startQueue()` no startup, que conecta imediatamente ao banco. Se o `DATABASE_URL` estiver errado, o worker crasheia. O web sobrevive porque a conexão é lazy.

### Cloud Run não conecta ao Cloud SQL private IP

Cloud Run precisa de VPC connector ou Direct VPC Egress para acessar IPs privados. Se o Cloud SQL tiver IP público com `0.0.0.0/0` em authorized_networks, use o IP público na connection string.

### Secret Manager cache no Cloud Run

Após atualizar um secret no Secret Manager, é preciso redeployer o Cloud Run service para que a nova revisão leia o valor atualizado:
```bash
gcloud run deploy SERVICE_NAME --image IMAGE --region REGION --project PROJECT --quiet
```

### PORT é variável reservada no Cloud Run

Cloud Run v2 seta `PORT` automaticamente. Não defina `PORT` como env var no Terraform — causa erro 400.
