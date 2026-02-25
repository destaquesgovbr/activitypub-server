# Airflow Local Dev (Astro CLI)

## Quick Start

```bash
cd airflow/

# Subir (precisa de TTY para importar airflow_settings.yaml)
script -q /dev/null astro dev start --no-browser --wait 5m

# Sem TTY, iniciar sem importar settings e configurar via .env
astro dev start --no-browser --settings-file ""

# Airflow UI
open http://localhost:8080

# Parar
astro dev stop
```

## Versões

| Componente | Versão |
|-----------|--------|
| Astro CLI | 1.39.0 |
| Astro Runtime | 3.0-14 (Airflow 3.0.6) |
| Docker image | `astrocrpublic.azurecr.io/runtime:3.0-14` |

Airflow 3.x usa o registry `astrocrpublic.azurecr.io` (não mais quay.io).

## Estrutura

```
airflow/
├── Dockerfile              # FROM astrocrpublic.azurecr.io/runtime:3.0-14
├── requirements.txt        # Python deps da DAG
├── packages.txt            # OS deps (vazio)
├── airflow_settings.yaml   # Connections + variables (gitignored)
├── .env                    # Env vars alternativas (gitignored)
├── .airflowignore          # Ignora node_modules, src, tests
├── docker-compose.override.yml  # federation-db container
├── dags -> ../dags         # Symlink para dags/ na raiz
├── include/                # Assets compartilhados (convenção Astro)
└── plugins/                # Plugins custom (convenção Astro)
```

## Configuração de Connections e Variables

### Via `airflow_settings.yaml` (preferido)

Importado automaticamente no `astro dev start`. Requer TTY (usar `script -q /dev/null` no Claude Code).

```yaml
airflow:
  connections:
    - conn_id: postgres_default
      conn_type: postgres
      conn_host: 34.39.145.55
      conn_schema: govbrnews
      conn_login: govbrnews_app
      conn_password: "<ver Secret Manager>"
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

### Via `.env` (alternativa)

Usado quando `airflow_settings.yaml` falha ou para CI.

```
AIRFLOW_CONN_POSTGRES_DEFAULT=postgresql://user:pass@host:5432/govbrnews
AIRFLOW_CONN_FEDERATION_POSTGRES=postgresql://federation:federation@federation-db:5432/federation
AIRFLOW_VAR_FEDERATION_WEB_URL=http://host.docker.internal:3000
AIRFLOW_VAR_FEDERATION_AUTH_TOKEN=dev-token
AIRFLOW_VAR_FEDERATION_INITIAL_WATERMARK=2026-02-20T00:00:00+00:00
```

## Databases

| Connection | Host | Descrição |
|-----------|------|-----------|
| `postgres_default` | `34.39.145.55` (Cloud SQL público) | govbrnews — fonte de notícias |
| `federation_postgres` | `federation-db` (container local) | Federation DB — fila de publicação |

O federation-db é inicializado automaticamente com `sql/schema.sql` via volume mount.

## Comandos úteis

```bash
# Ver containers
astro dev ps

# Logs
astro dev logs --follow

# Rodar comando Airflow
astro dev run dags list
astro dev run dags trigger federation_publish
astro dev run variables list

# Rebuild após mudar requirements.txt
astro dev restart

# Limpar tudo (remove volumes)
astro dev kill
```

## TTY no Claude Code

O `astro dev start` precisa de TTY para importar `airflow_settings.yaml`. No Claude Code, usar:

```bash
script -q /dev/null astro dev start --no-browser --wait 5m
```

## Astro CLI config

O Astro está configurado para usar Docker (não Podman):

```bash
astro config set -g container.binary docker
```
