# Ambiente Local Airflow com Astro CLI

## Contexto

A DAG `federation_publish` roda no Cloud Composer (Airflow 3.0.1), mas cada iteração exige commit → PR → merge → deploy → esperar Composer recarregar → verificar logs pelo GCP. Para acelerar o ciclo de desenvolvimento, queremos rodar o Airflow localmente com Astro CLI.

## Versões

| Componente | Versão | Notas |
|-----------|--------|-------|
| Astro CLI | 1.39.0 | `brew install astro` |
| Astro Runtime | 3.0-14 | Airflow 3.0.6 (compatível com Composer 3.0.1) |
| Python | 3.12 | Incluído no runtime |
| PostgreSQL | 15 | Federation DB local |

**Alternativa**: Runtime 3.1-13 (Airflow 3.1.7) se quisermos testar features novas. DAGs são retrocompatíveis.

## Instalação do Astro CLI

```bash
# Via Homebrew (macOS) — instala Podman por padrão desde v1.32
brew install astro

# Se preferir Docker em vez de Podman:
brew tap astronomer/tap
brew install astronomer/tap/astro --without-podman
```

## Estrutura de arquivos

Arquivos a criar no `activitypub-server/`:

```
activitypub-server/
├── dags/                          ← já existe
│   └── federation_publish.py
├── include/                       ← novo (vazio, convenção Astro)
├── plugins/                       ← novo (vazio, convenção Astro)
├── Dockerfile.astro               ← novo (imagem Airflow)
├── requirements.txt               ← novo (deps Python da DAG)
├── packages.txt                   ← novo (deps OS, vazio)
├── airflow_settings.yaml          ← novo (connections/variables locais, gitignored)
├── .airflowignore                 ← novo
├── docker-compose.override.yml    ← novo (federation DB + Cloud SQL Proxy)
├── docker-compose.yml             ← já existe (mantém como está)
└── .gitignore                     ← atualizar
```

## Arquivos

### `Dockerfile.astro`

```dockerfile
FROM quay.io/astronomer/astro-runtime:3.0-14
```

O runtime inclui ONBUILD instructions que copiam e instalam `requirements.txt` e `packages.txt` automaticamente.

### `requirements.txt`

```
apache-airflow-providers-postgres>=5.10.0
psycopg2-binary>=2.9.9
requests>=2.32.0
```

### `packages.txt`

```
# OS-level packages (vazio por enquanto)
```

### `.airflowignore`

```
__pycache__
.git
node_modules
tests
src
```

### `airflow_settings.yaml` (gitignored — contém credenciais)

```yaml
airflow:
  connections:
    - conn_id: postgres_default
      conn_type: postgres
      conn_host: cloud-sql-proxy
      conn_schema: govbrnews
      conn_login: app
      conn_password: <senha do app user — ver Secret Manager>
      conn_port: 5432
    - conn_id: federation_postgres
      conn_type: postgres
      conn_host: federation-db
      conn_schema: federation
      conn_login: federation
      conn_password: federation
      conn_port: 5432
  variables:
    - variable_name: federation_web_url
      variable_value: http://host.docker.internal:3000
    - variable_name: federation_auth_token
      variable_value: dev-token
    - variable_name: federation_initial_watermark
      variable_value: "2026-02-20T00:00:00+00:00"
  pools: []
```

### `docker-compose.override.yml`

O Astro CLI lê este arquivo automaticamente ao rodar `astro dev start`. Adiciona o federation DB local e o Cloud SQL Proxy para acessar o govbrnews de produção.

```yaml
services:
  federation-db:
    image: postgres:15
    environment:
      POSTGRES_DB: federation
      POSTGRES_USER: federation
      POSTGRES_PASSWORD: federation
    ports:
      - "5433:5432"
    volumes:
      - ./sql/schema.sql:/docker-entrypoint-initdb.d/01-schema.sql
      - federation-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U federation -d federation"]
      interval: 2s
      timeout: 5s
      retries: 10

  cloud-sql-proxy:
    image: gcr.io/cloud-sql-connectors/cloud-sql-proxy:2
    command:
      - "inspire-7-finep:southamerica-east1:destaquesgovbr-postgres"
      - "--address=0.0.0.0"
      - "--port=5432"
    ports:
      - "5434:5432"
    volumes:
      - $HOME/.config/gcloud:/root/.config/gcloud:ro

volumes:
  federation-pgdata:
```

### `.gitignore` (adicionar)

```
# Astro / Airflow local
airflow_settings.yaml
.astro/
```

## Fluxo de uso

```bash
# 1. Autenticar no GCP (necessário para Cloud SQL Proxy)
gcloud auth application-default login

# 2. Subir Airflow local + federation DB + Cloud SQL Proxy
astro dev start

# 3. Acessar Airflow UI
#    http://localhost:8080 (admin/admin)

# 4. A DAG federation_publish aparece automaticamente
#    Trigger manual pela UI ou CLI:
astro dev run dags trigger federation_publish

# 5. Ver logs
astro dev logs --follow

# 6. Parar tudo
astro dev stop
```

## Pré-requisitos

1. **Docker** ou **Podman** rodando
2. **gcloud CLI** autenticado (`gcloud auth application-default login`)
3. **Astro CLI** instalado (`brew install astro`)
4. Credenciais do `app` user do govbrnews (para `airflow_settings.yaml`)

## Notas

- O `docker-compose.yml` existente (usado pelos testes Node.js) não é afetado. O Astro usa seu próprio compose + override.
- `airflow_settings.yaml` fica no `.gitignore` pois contém senhas. Cada dev configura o seu.
- O Cloud SQL Proxy usa as credenciais ADC (Application Default Credentials) do gcloud.
- O Astro CLI precisa da porta 8080 livre (webserver) e 5555 (flower, se celery).

## Referências

- [Astro CLI — Install](https://www.astronomer.io/docs/astro/cli/install-cli)
- [Astro Runtime Release Notes](https://www.astronomer.io/docs/runtime/runtime-release-notes)
- [Astro Runtime 3.0-14](https://www.astronomer.io/docs/runtime/runtime-release-notes) — Airflow 3.0.6
- [Upgrade to Airflow 3](https://www.astronomer.io/docs/astro/airflow3/upgrade-af3)
- [Cloud SQL Proxy Docker](https://cloud.google.com/sql/docs/postgres/connect-auth-proxy)
