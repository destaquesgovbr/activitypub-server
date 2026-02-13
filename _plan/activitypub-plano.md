# Plano de Implementação — ActivityPub Federation

## Contexto

O Portal Destaques Gov.br agrega notícias de 156 órgãos governamentais, classificadas em 25 temas de nível 1. Atualmente não existe forma de cidadãos no fediverso (Mastodon, Lemmy, etc.) seguirem o portal. Esta feature cria **~182 actors ActivityPub** (1 por órgão + 1 por tema + 1 portal principal), permitindo que usuários sigam feeds específicos e recebam artigos diretamente em suas timelines.

**Pipeline**: Sem arquitetura orientada a eventos, o Airflow (Cloud Composer) roda uma DAG periódica que detecta artigos novos no PostgreSQL e alimenta a fila de publicação. Um serviço Cloud Run dedicado processa a fila e entrega atividades aos servidores remotos.

**Infraestrutura existente que será reaproveitada**:
- Cloud SQL PostgreSQL 15 (`govbrnews`, southamerica-east1)
- Cloud Composer / Airflow 3.1.0 (us-central1)
- Secret Manager (connection strings, API keys)
- Artifact Registry + GitHub Actions CI/CD

---

## Arquitetura Geral

```
                     destaques.gov.br
                           │
                  ┌────────┴────────┐
                  │  Cloud LB (HTTPS)│
                  │  URL Map:        │
                  │  /ap/*  ────────►│──► federation-web (Cloud Run)
                  │  /.well-known/* ►│──► federation-web
                  │  /*  ───────────►│──► portal (Cloud Run, existente)
                  └─────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                  │
  ┌──────┴──────┐  ┌──────┴──────┐  ┌───────┴───────┐
  │ federation  │  │ federation  │  │    portal      │
  │    web      │  │   worker    │  │  (existente)   │
  │ (Cloud Run) │  │ (Cloud Run) │  │  Next.js 15    │
  │             │  │             │  └────────────────┘
  │ Endpoints:  │  │ Processa:   │
  │ WebFinger   │  │ fedify_msg  │
  │ Actor JSON  │  │ queue       │
  │ Inbox POST  │  │ (fan-out    │
  │ Outbox GET  │  │  para       │
  │ /trigger    │  │  followers) │
  └──────┬──────┘  └──────┬──────┘
         │                │
         └───────┬────────┘
                 │
         ┌───────┴────────┐
         │  Cloud SQL      │
         │  PostgreSQL 15  │
         │  (existente)    │
         │                 │
         │ + ap_actors     │
         │ + ap_followers  │
         │ + ap_activities │
         │ + ap_publish_q  │
         │ + ap_delivery   │
         │ + fedify_kv_v2  │
         │ + fedify_msg_v2 │
         └───────┬─────────┘
                 │
         ┌───────┴────────┐
         │ Cloud Composer  │
         │ Airflow 3.1.0   │
         │                 │
         │ DAG: detect_new │
         │ _articles_for   │
         │ _federation     │
         │ (a cada 30 min) │
         └─────────────────┘
```

---

## Tecnologia: Fedify

- **`@fedify/fedify`** — Framework ActivityPub para TypeScript (financiado pelo Sovereign Tech Fund, €192k)
- **`@fedify/postgres`** — `PostgresKvStore` + `PostgresMessageQueue` para estado persistente
- **Não usar `@fedify/next`** — serviço separado, não embutido no portal

O Fedify abstrai: HTTP Signatures (4 mecanismos), WebFinger, content negotiation, delivery com retry, serialização JSON-LD/ActivityStreams 2.0.

---

## Actors (182 total)

| Tipo | Quantidade | Identifier Pattern | ActivityPub Type | Exemplo WebFinger |
|------|-----------|-------------------|-----------------|-------------------|
| Portal | 1 | `portal` | `Application` | `@portal@destaques.gov.br` |
| Órgão | 156 | `{agency_key}` | `Organization` | `@agricultura@destaques.gov.br` |
| Tema | 25 | `tema-{code}` | `Group` | `@tema-01@destaques.gov.br` |

Cada actor tem:
- Par de chaves RSA-2048 (HTTP Signatures) + Ed25519 (Object Integrity Proofs)
- Perfil com nome, descrição, ícone
- Inbox, Outbox, Followers collection próprios

Quando um artigo é publicado, ele gera atividades para **3 actors**: órgão + tema nível 1 + portal principal.

---

## Schema do Banco de Dados (novas tabelas)

### `ap_actors` — Configuração dos 182 actors

```sql
CREATE TABLE ap_actors (
    id SERIAL PRIMARY KEY,
    identifier VARCHAR(150) UNIQUE NOT NULL,    -- "agricultura", "tema-01", "portal"
    actor_type VARCHAR(20) NOT NULL             -- 'agency', 'theme', 'portal'
        CHECK (actor_type IN ('agency', 'theme', 'portal')),
    display_name VARCHAR(500) NOT NULL,
    summary TEXT,
    icon_url TEXT,
    agency_key VARCHAR(100),                    -- Para actors de órgão
    theme_code VARCHAR(10),                     -- Para actors de tema
    rsa_public_key_jwk JSONB NOT NULL,
    rsa_private_key_jwk JSONB NOT NULL,
    ed25519_public_key_jwk JSONB,
    ed25519_private_key_jwk JSONB,
    keys_generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### `ap_followers` — Seguidores remotos

```sql
CREATE TABLE ap_followers (
    id SERIAL PRIMARY KEY,
    actor_id INTEGER NOT NULL REFERENCES ap_actors(id) ON DELETE CASCADE,
    follower_uri TEXT NOT NULL,
    follower_inbox_uri TEXT NOT NULL,
    follower_shared_inbox_uri TEXT,
    follower_server TEXT NOT NULL,              -- "mastodon.social"
    follow_activity_uri TEXT,
    status VARCHAR(20) DEFAULT 'active'
        CHECK (status IN ('active', 'pending', 'removed')),
    followed_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(actor_id, follower_uri)
);
CREATE INDEX idx_ap_followers_actor ON ap_followers(actor_id) WHERE status = 'active';
```

### `ap_publish_queue` — Fila de publicação (preenchida pelo Airflow)

```sql
CREATE TABLE ap_publish_queue (
    id SERIAL PRIMARY KEY,
    news_unique_id VARCHAR(32) NOT NULL,
    actor_identifier VARCHAR(150) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'published', 'failed')),
    error_message TEXT,
    queued_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    UNIQUE(news_unique_id, actor_identifier)
);
CREATE INDEX idx_ap_publish_queue_pending ON ap_publish_queue(queued_at)
    WHERE status = 'pending';
```

### `ap_activities` — Log de atividades publicadas

```sql
CREATE TABLE ap_activities (
    id SERIAL PRIMARY KEY,
    activity_uri TEXT UNIQUE NOT NULL,
    activity_type VARCHAR(50) NOT NULL,         -- 'Create', 'Update', 'Delete'
    actor_id INTEGER NOT NULL REFERENCES ap_actors(id),
    news_unique_id VARCHAR(32) NOT NULL,
    total_recipients INTEGER DEFAULT 0,
    delivered_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'queued'
        CHECK (status IN ('queued', 'delivering', 'completed', 'partial', 'failed')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    delivery_completed_at TIMESTAMPTZ
);
```

### `ap_delivery_log` — Log de entrega por servidor

```sql
CREATE TABLE ap_delivery_log (
    id SERIAL PRIMARY KEY,
    activity_id INTEGER NOT NULL REFERENCES ap_activities(id) ON DELETE CASCADE,
    target_inbox_uri TEXT NOT NULL,
    target_server TEXT NOT NULL,
    status VARCHAR(20) NOT NULL
        CHECK (status IN ('pending', 'success', 'failed', 'abandoned')),
    http_status_code SMALLINT,
    error_message TEXT,
    attempt_count SMALLINT DEFAULT 0,
    next_retry_at TIMESTAMPTZ,
    first_attempted_at TIMESTAMPTZ DEFAULT NOW(),
    succeeded_at TIMESTAMPTZ
);
CREATE INDEX idx_ap_delivery_pending ON ap_delivery_log(next_retry_at)
    WHERE status = 'failed';
```

### `ap_dead_servers` — Servidores permanentemente inalcançáveis

```sql
CREATE TABLE ap_dead_servers (
    id SERIAL PRIMARY KEY,
    server_hostname TEXT UNIQUE NOT NULL,
    consecutive_failures INTEGER DEFAULT 0,
    first_failure_at TIMESTAMPTZ,
    last_failure_at TIMESTAMPTZ,
    is_dead BOOLEAN DEFAULT FALSE,
    next_probe_at TIMESTAMPTZ                   -- Re-tentar semanalmente
);
```

### `ap_sync_watermark` — Marca d'água do Airflow

```sql
CREATE TABLE ap_sync_watermark (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- Singleton
    last_processed_at TIMESTAMPTZ NOT NULL,
    last_run_at TIMESTAMPTZ NOT NULL,
    articles_queued INTEGER DEFAULT 0
);
INSERT INTO ap_sync_watermark (last_processed_at, last_run_at) VALUES (NOW(), NOW());
```

### Alteração na tabela `news` existente

```sql
ALTER TABLE news ADD COLUMN federated_at TIMESTAMPTZ;
CREATE INDEX idx_news_not_federated ON news(created_at) WHERE federated_at IS NULL;
```

### Tabelas do Fedify (criadas automaticamente)

- `fedify_kv_v2` — Cache de documentos remotos, chaves públicas
- `fedify_message_v2` — Fila de mensagens para entrega (fan-out)

---

## Cloud Run — Arquitetura Web + Worker

Uma imagem Docker, dois modos via `NODE_TYPE`:

### Federation Web (`NODE_TYPE=web`)

- **Função**: Serve endpoints HTTP do ActivityPub
- **Endpoints**:
  - `GET /.well-known/webfinger` — Descoberta de actors
  - `GET /.well-known/nodeinfo` — Metadados do servidor
  - `GET /ap/actors/{identifier}` — Perfil JSON-LD do actor
  - `POST /ap/actors/{identifier}/inbox` — Recebe Follow/Undo de servidores remotos
  - `GET /ap/actors/{identifier}/outbox` — Lista atividades publicadas
  - `GET /ap/actors/{identifier}/followers` — Coleção de seguidores
  - `GET /ap/articles/{unique_id}` — Objeto Article individual
  - `POST /trigger-publish` — Chamado pelo Airflow para processar a fila
  - `GET /health` — Health check
- **Scaling**: 1-5 instâncias, 1 vCPU, 1 GiB RAM
- **`manuallyStartQueue: true`** — NÃO processa fila de entrega

### Federation Worker (`NODE_TYPE=worker`)

- **Função**: Processa a fila de entrega do Fedify (`fedify_message_v2`)
- **Comportamento**:
  1. Chama `federation.startQueue()` na inicialização
  2. Fedify decompõe "enviar para followers" em tarefas individuais por inbox
  3. Para cada inbox: assina request com RSA do actor → POST no servidor remoto
  4. Em caso de falha: re-enfileira com backoff exponencial
  5. Usa `preferSharedInbox: true` para deduplicar entregas por servidor
- **Scaling**: 1-3 instâncias, 1 vCPU, 1 GiB RAM
- **`min_instance_count: 1`** — Sempre rodando para processar fila
- **Tráfego**: Nenhum externo (INGRESS_TRAFFIC_INTERNAL_ONLY)
- **Timeout**: 3600s (long-running queue processing)

### Fluxo do Fan-out

```
Airflow detecta 10 artigos novos
  → INSERT 30 entradas em ap_publish_queue (10 artigos × 3 actors)
  → POST /trigger-publish no federation-web

Federation Web (/trigger-publish):
  → SELECT * FROM ap_publish_queue WHERE status = 'pending' LIMIT 100
  → Para cada entrada:
      1. Busca artigo do PostgreSQL (news table)
      2. Busca actor do PostgreSQL (ap_actors table)
      3. Constrói Create{Article} activity
      4. ctx.sendActivity(actor, "followers", activity, {preferSharedInbox: true})
         → Fedify enfileira na fedify_message_v2
      5. Marca ap_publish_queue como 'published'

Federation Worker (contínuo):
  → Processa fedify_message_v2
  → Para cada mensagem:
      1. Resolve followers do actor → lista de inboxes
      2. Agrupa por shared_inbox (1 POST por servidor, não por seguidor)
      3. Assina HTTP request com RSA key do actor
      4. POST para remote inbox
      5. Success → log em ap_delivery_log
      6. Failure → re-enqueue com backoff, incrementa ap_dead_servers
```

**Exemplo concreto**: Artigo do MRE sobre diplomacia (tema 12):
- 3 entradas na fila: `(artigo_id, "mre")`, `(artigo_id, "tema-12")`, `(artigo_id, "portal")`
- Se `@mre` tem 50 seguidores em 30 servidores → 30 POSTs (shared inbox)
- Se `@tema-12` tem 20 seguidores em 15 servidores → 15 POSTs
- Se `@portal` tem 200 seguidores em 80 servidores → 80 POSTs
- Total: 125 HTTP requests, processados assincronamente pelo worker

---

## Airflow DAG: `detect_new_articles_for_federation`

### Configuração

```python
schedule = "*/30 * * * *"    # A cada 30 minutos
catchup = False
retries = 2
retry_delay = timedelta(minutes=5)
tags = ["activitypub", "federation"]
```

### Tasks

**Task 1: `detect_new_articles`**
1. Lê `ap_sync_watermark.last_processed_at`
2. Query: `SELECT unique_id, agency_key, theme_l1_id FROM news WHERE created_at > watermark ORDER BY created_at`
3. Para cada artigo, resolve actors:
   - Actor do órgão: `SELECT identifier FROM ap_actors WHERE agency_key = ?`
   - Actor do tema: `SELECT identifier FROM ap_actors WHERE theme_code = ?`
   - Actor portal: sempre `'portal'`
4. `INSERT INTO ap_publish_queue (news_unique_id, actor_identifier) ... ON CONFLICT DO NOTHING`
5. Atualiza `ap_sync_watermark`
6. Retorna contagem

**Task 2: `trigger_federation_publish`**
1. Se task 1 retornou artigos > 0:
2. `POST https://federation-web-url/trigger-publish` com token de autenticação service-to-service
3. Retorna status da resposta

### Localização

```
activitypub-server/dags/detect_new_articles_for_federation.py
```

A DAG fica no repositório `activitypub-server` e é deployada para o Cloud Composer via GitHub Actions (mesmo padrão do `data-platform`).

Segue o mesmo padrão do DAG existente `sync_postgres_to_huggingface.py` (no data-platform):
- Usa `Variable.get()` para secrets
- Conexão postgres via `airflow-connections-postgres_default`

---

## Terraform — Novos Recursos

### Arquivo: `infra/terraform/federation.tf`

```hcl
# 1. Service Account
resource "google_service_account" "federation" {
  account_id   = "${var.project_name}-federation"
  display_name = "Federation Service"
}
# + roles: cloudsql.client, secretmanager.secretAccessor, logging.logWriter

# 2. Cloud Run: federation-web
resource "google_cloud_run_v2_service" "federation_web" {
  name     = "${var.project_name}-federation"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  template {
    scaling { min_instance_count = 1; max_instance_count = 5 }
    containers {
      resources { limits = { cpu = "1", memory = "1Gi" } }
      env { name = "NODE_TYPE"; value = "web" }
      env { name = "DATABASE_URL"; value_source { secret_key_ref { ... } } }
    }
    service_account = google_service_account.federation.email
    vpc_access { connector = google_vpc_access_connector.federation.id }
  }
}

# 3. Cloud Run: federation-worker
resource "google_cloud_run_v2_service" "federation_worker" {
  name     = "${var.project_name}-federation-worker"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  template {
    scaling { min_instance_count = 1; max_instance_count = 3 }
    containers {
      resources { limits = { cpu = "1", memory = "1Gi" } }
      env { name = "NODE_TYPE"; value = "worker" }
    }
    timeout = "3600s"
    service_account = google_service_account.federation.email
    vpc_access { connector = google_vpc_access_connector.federation.id }
  }
}

# 4. VPC Connector (para acesso ao Cloud SQL via private IP)
resource "google_vpc_access_connector" "federation" {
  name          = "federation-connector"
  region        = var.region
  network       = google_compute_network.main.id
  ip_cidr_range = "10.8.0.0/28"
}

# 5. Serverless NEGs (para o Load Balancer)
resource "google_compute_region_network_endpoint_group" "federation" {
  name                  = "federation-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run { service = google_cloud_run_v2_service.federation_web.name }
}

resource "google_compute_region_network_endpoint_group" "portal" {
  name                  = "portal-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run { service = google_cloud_run_v2_service.portal.name }  # existente
}
```

### Arquivo: `infra/terraform/load_balancer.tf`

```hcl
# 6. Global HTTPS Load Balancer
resource "google_compute_global_address" "main" { name = "destaques-lb-ip" }

resource "google_compute_managed_ssl_certificate" "main" {
  name = "destaques-cert"
  managed { domains = ["destaques.gov.br"] }
}

resource "google_compute_backend_service" "portal" {
  name        = "portal-backend"
  backend { group = google_compute_region_network_endpoint_group.portal.id }
}

resource "google_compute_backend_service" "federation" {
  name        = "federation-backend"
  backend { group = google_compute_region_network_endpoint_group.federation.id }
}

resource "google_compute_url_map" "main" {
  name            = "destaques-url-map"
  default_service = google_compute_backend_service.portal.id

  host_rule {
    hosts        = ["destaques.gov.br"]
    path_matcher = "main"
  }

  path_matcher {
    name            = "main"
    default_service = google_compute_backend_service.portal.id

    path_rule {
      paths   = ["/ap/*"]
      service = google_compute_backend_service.federation.id
    }
    path_rule {
      paths   = ["/.well-known/webfinger", "/.well-known/nodeinfo"]
      service = google_compute_backend_service.federation.id
    }
  }
}

resource "google_compute_target_https_proxy" "main" {
  name             = "destaques-https-proxy"
  url_map          = google_compute_url_map.main.id
  ssl_certificates = [google_compute_managed_ssl_certificate.main.id]
}

resource "google_compute_global_forwarding_rule" "main" {
  name       = "destaques-https-rule"
  target     = google_compute_target_https_proxy.main.id
  ip_address = google_compute_global_address.main.address
  port_range = "443"
}
```

### Arquivo: `infra/terraform/secrets.tf` (adicionar)

```hcl
resource "google_secret_manager_secret" "federation_auth_token" {
  secret_id = "federation-auth-token"
  replication { auto {} }
}
```

### Custo mensal estimado

| Recurso | Custo |
|---------|-------|
| Federation Web (1 inst. min, 1 vCPU, 1 GiB) | ~$35 |
| Federation Worker (1 inst. min, 1 vCPU, 1 GiB) | ~$35 |
| Cloud Load Balancer (HTTPS global) | ~$18 + tráfego |
| SSL Certificate (managed) | Grátis |
| PostgreSQL storage adicional (~5 GB/ano) | ~$1 |
| **Total incremental** | **~$90/mês** |

---

## Complexidade Operacional — Detalhamento

### Monitorar Entrega

**Métricas customizadas** (exportadas pelo worker via Cloud Monitoring):

| Métrica | O que mede |
|---------|-----------|
| `federation/deliveries_attempted` | POSTs para inboxes remotos |
| `federation/deliveries_succeeded` | Entregas bem-sucedidas (HTTP 2xx) |
| `federation/deliveries_failed` | Entregas falhadas |
| `federation/queue_depth` | Mensagens pendentes em `fedify_message_v2` |
| `federation/followers_total` | Total de seguidores ativos |
| `federation/dead_servers` | Servidores marcados como mortos |

**Alertas**:
- Taxa de falha > 50% por 30 min → Critical
- Queue depth > 500 por 1 hora → Warning
- Worker com 0 instâncias → Critical
- DAG falhou 3x consecutivas → Critical

**Dashboard SQL** para investigação:

```sql
-- Taxa de sucesso por servidor (últimas 24h)
SELECT target_server,
    COUNT(*) FILTER (WHERE status = 'success') as ok,
    COUNT(*) FILTER (WHERE status = 'failed') as fail,
    ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'success') / COUNT(*), 1) as pct
FROM ap_delivery_log
WHERE first_attempted_at > NOW() - INTERVAL '24 hours'
GROUP BY target_server ORDER BY fail DESC LIMIT 20;
```

### Lidar com Servidores que Falham

**3 categorias de falha**:

1. **Transiente** (timeout, 5xx): Fedify re-enfileira com backoff exponencial (1min → 5min → 30min → 2h → 12h)
2. **Permanente** (DNS failure, connection refused): Após **50 falhas consecutivas**, `ap_dead_servers.is_dead = TRUE`. Entregas para seguidores nesse servidor são **skippadas**
3. **Recuperação**: Uma vez por semana, um job (Airflow ou cron) reseta `is_dead = FALSE` para 1 tentativa de probe. Se suceder, zera o contador

**Impacto dos servidores mortos**: Se mastodon.social ficar fora por 2 dias, as entregas são retentadas com backoff. Se ficar fora por 2 semanas (50+ falhas), é marcado como morto. Quando voltar, o probe semanal detecta e reativa.

**Limpeza de seguidores**: Seguidores em servidores mortos por > 90 dias são marcados como `status = 'removed'`. Se o servidor voltar, o usuário precisará re-seguir (comportamento padrão do fediverso).

### Manter Chaves RSA

**Geração**: Uma vez, via script `generate-keys.ts`. Gera RSA-2048 + Ed25519 para todos os 182 actors.

**Armazenamento**: Na tabela `ap_actors` como JSONB (JWK format). Cloud SQL encripta em repouso. Chaves privadas nunca saem do banco.

**Rotação: NÃO rotacionar de rotina.** No ActivityPub, servidores remotos cacheiam chaves públicas. Rotação causa falhas de verificação de assinatura em todo o fediverso até que os caches expirem (pode levar dias). Rotacionar apenas em caso de comprometimento.

**Em caso de comprometimento**:
1. Gerar novo par de chaves para o actor afetado
2. Atualizar `ap_actors`
3. O Fedify anuncia múltiplas chaves no perfil do actor — servidores remotos eventualmente buscam a nova chave
4. Período de transição: ~24-48h de entregas falhadas até caches remotos expirarem

### Crescimento do Banco

| Tabela | Crescimento/dia | Tamanho em 1 ano |
|--------|----------------|------------------|
| `ap_actors` | Estático | ~1 MB |
| `ap_followers` | ~5-20 rows | ~3 MB |
| `ap_activities` | ~300 rows | ~33 MB |
| `ap_delivery_log` | ~300-3000 rows | ~5 GB (com pruning) |
| `ap_publish_queue` | ~300 rows (prunado) | ~1 MB |

**Pruning**: Job semanal (Airflow) que:
- Deleta `ap_delivery_log` com `status = 'success'` e `> 90 dias`
- Deleta `ap_publish_queue` com `status = 'published'` e `> 7 dias`
- Agrega stats antes de deletar (para dashboard histórico)

---

## Estrutura do Repositório

**Repositório**: `destaquesgovbr/activitypub-server` (novo, independente)

```
activitypub-server/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── docker-compose.yml             # Dev: Postgres + servidor + cliente AP (testes e2e)
├── docker-compose.test.yml        # CI: Postgres para testes de integração
├── Dockerfile
├── _plan/                         # Documentação de planos
│   └── activitypub-plano.md
├── sql/
│   └── schema.sql                 # Schema completo das tabelas ap_*
├── src/
│   ├── index.ts                   # Entry: web server (Hono) + worker mode
│   ├── federation.ts              # createFederation() com PostgresKvStore/Queue
│   ├── actors.ts                  # setActorDispatcher, setKeyPairsDispatcher
│   ├── inbox.ts                   # Follow, Undo{Follow} handlers
│   ├── outbox.ts                  # Outbox collection dispatcher
│   ├── publisher.ts               # /trigger-publish: lê ap_publish_queue, chama sendActivity
│   ├── article-builder.ts         # Constrói Article ActivityPub a partir de news row
│   ├── db.ts                      # Conexão PostgreSQL (postgres.js)
│   ├── keys.ts                    # Utilitários de chaves (JWK ↔ CryptoKey)
│   ├── dead-servers.ts            # Lógica de detecção de servidores mortos
│   ├── metrics.ts                 # Export de métricas customizadas
│   └── types.ts
├── dags/                          # Airflow DAGs (deploy via CI para Cloud Composer)
│   └── detect_new_articles_for_federation.py
├── scripts/
│   ├── seed-actors.ts             # Popula ap_actors a partir dos YAMLs
│   ├── generate-keys.ts           # Gera RSA + Ed25519 para todos actors
│   └── migrate.ts                 # Roda migrações SQL
└── tests/                         # Suite de testes (ver plano de testes separado)
    ├── unit/
    ├── integration/
    └── e2e/
```

**Framework HTTP**: [Hono](https://hono.dev/) — leve, rápido, TypeScript-first. O Fedify tem integração oficial com Hono via `@fedify/express` ou integração manual simples.

---

## Formato das Atividades Publicadas

```json
{
  "@context": "https://www.w3.org/ns/activitystreams",
  "id": "https://destaques.gov.br/ap/activities/{ulid}",
  "type": "Create",
  "actor": "https://destaques.gov.br/ap/actors/agricultura",
  "published": "2026-02-12T14:00:00Z",
  "to": ["https://www.w3.org/ns/activitystreams#Public"],
  "cc": ["https://destaques.gov.br/ap/actors/agricultura/followers"],
  "object": {
    "id": "https://destaques.gov.br/ap/articles/{unique_id}",
    "type": "Article",
    "attributedTo": "https://destaques.gov.br/ap/actors/agricultura",
    "name": "Título da Notícia",
    "content": "<p>Conteúdo HTML do artigo...</p>",
    "summary": "Resumo para preview",
    "url": "https://destaques.gov.br/artigos/{unique_id}",
    "published": "2026-02-12T14:00:00Z",
    "image": {
      "type": "Image",
      "url": "https://destaques.gov.br/images/noticia.jpg"
    },
    "tag": [
      { "type": "Hashtag", "name": "#diplomacia" }
    ]
  }
}
```

---

## Fases de Implementação

### Fase 1: Fundação (2-3 semanas)
- Criar scaffold do repositório `activitypub-server`
- Rodar migrações SQL (todas as tabelas `ap_*`)
- Script `seed-actors.ts` para popular 182 actors a partir de `agencies.yaml` + `themes.yaml`
- Script `generate-keys.ts` para gerar chaves RSA + Ed25519
- Implementar `federation.ts`, `actors.ts`, `keys.ts`
- Testar localmente: WebFinger + perfis de actors
- Dockerfile + Terraform para federation-web
- Deploy e verificar actors acessíveis

### Fase 2: Load Balancer + Follow/Accept (2 semanas)
- Terraform do Cloud Load Balancer com URL routing
- SSL certificate managed para `destaques.gov.br`
- Implementar `inbox.ts` (Follow, Undo handlers)
- Implementar followers collection dispatcher
- Deploy e testar follow de um Mastodon real
- Verificar Accept é enviado e follow aparece no Mastodon

### Fase 3: Pipeline de Publicação (2-3 semanas)
- Adicionar coluna `federated_at` na tabela `news`
- Criar DAG Airflow `detect_new_articles_for_federation`
- Implementar `publisher.ts` (`/trigger-publish`)
- Deploy federation-worker + Terraform
- Configurar autenticação Airflow → Cloud Run
- Teste end-to-end: artigo novo → DAG detecta → publica → aparece na timeline

### Fase 4: Resiliência e Monitoramento (1-2 semanas)
- Dead server detection
- `ap_delivery_log` population
- Dashboard Cloud Monitoring
- Alertas
- Pruning jobs
- Load test (simular 1000 followers)
- Runbook operacional

### Fase 5: Polish (1 semana)
- NodeInfo endpoint
- Ícones dos actors (imagens dos órgãos/temas)
- Support para `Update{Article}` (artigo editado)
- Documentação

---

## Verificação

```bash
# 1. WebFinger discovery
curl -s "https://destaques.gov.br/.well-known/webfinger?resource=acct:agricultura@destaques.gov.br" | python3 -m json.tool

# 2. Actor profile (JSON-LD)
curl -s -H "Accept: application/activity+json" "https://destaques.gov.br/ap/actors/agricultura" | python3 -m json.tool

# 3. Testar follow via Mastodon
# Buscar @agricultura@destaques.gov.br no Mastodon e seguir

# 4. Verificar followers
curl -s -H "Accept: application/activity+json" "https://destaques.gov.br/ap/actors/agricultura/followers" | python3 -m json.tool

# 5. Verificar outbox
curl -s -H "Accept: application/activity+json" "https://destaques.gov.br/ap/actors/agricultura/outbox" | python3 -m json.tool

# 6. Trigger manual da publicação
curl -X POST "https://federation-internal-url/trigger-publish" -H "Authorization: Bearer $TOKEN"

# 7. Health check
curl -s "https://federation-internal-url/health"

# 8. Verificar queue depth (PostgreSQL)
psql -c "SELECT status, COUNT(*) FROM ap_publish_queue GROUP BY status;"
psql -c "SELECT COUNT(*) FROM fedify_message_v2;"

# 9. Verificar delivery stats
psql -c "SELECT target_server, status, COUNT(*) FROM ap_delivery_log GROUP BY target_server, status ORDER BY count DESC LIMIT 10;"
```

---

## Arquivos Críticos (referência — outros repositórios)

| Arquivo | Repositório | Função |
|---------|------------|--------|
| `terraform/portal.tf` | infra | Padrão para Cloud Run service |
| `terraform/cloud_sql.tf` | infra | Config do PostgreSQL existente |
| `terraform/composer.tf` | infra | Config do Cloud Composer |
| `terraform/secrets.tf` | infra | Padrão para secrets |
| `scripts/create_schema.sql` | data-platform | Schema existente a estender |
| `src/data_platform/dags/sync_postgres_to_huggingface.py` | data-platform | Padrão para DAG |
| `src/config/agencies.yaml` | portal | Fonte para actors de órgão |
| `src/config/themes.yaml` | portal | Fonte para actors de tema |
| `src/types/article.ts` | portal | Tipo ArticleRow (mapping para Activity) |
