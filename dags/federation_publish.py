"""
DAG para detectar novas noticias e enfileirar para publicacao via ActivityPub.

Executa a cada 10 minutos. Le watermark do banco federation,
consulta novas noticias no govbrnews em batches de 500, insere na fila
de publicacao com payload completo, e dispara /trigger-publish no
federation server.

O watermark e atualizado a cada batch, entao retries retomam de onde pararam.

Configuracao:
  - Airflow Variable "federation_initial_watermark": timestamp ISO para
    primeira execucao (default: 7 dias atras). Usado apenas quando nao
    existe watermark no banco.
"""

import json
import logging
from datetime import datetime, timedelta, timezone

from airflow.decorators import dag, task
from airflow.models import Variable
from airflow.providers.postgres.hooks.postgres import PostgresHook

BATCH_SIZE = 500


@dag(
    dag_id="federation_publish",
    description="Detecta novas noticias e enfileira para publicacao ActivityPub",
    schedule="*/10 * * * *",
    start_date=datetime(2025, 1, 1),
    catchup=False,
    max_active_runs=1,
    tags=["federation", "activitypub"],
    default_args={
        "owner": "activitypub-server",
        "depends_on_past": False,
        "email_on_failure": False,
        "email_on_retry": False,
        "retries": 2,
        "retry_delay": timedelta(minutes=2),
    },
)
def federation_publish_dag():

    @task
    def detect_and_enqueue() -> dict:
        """Fetch articles in batches, enqueue each, update watermark per batch."""
        from psycopg2.extras import execute_values

        govbr_hook = PostgresHook(postgres_conn_id="postgres_default")
        fed_hook = PostgresHook(postgres_conn_id="federation_postgres")
        fed_conn = fed_hook.get_conn()
        fed_cur = fed_conn.cursor()

        # Read current watermark from federation DB
        fed_cur.execute(
            "SELECT last_processed_at FROM ap_sync_watermark WHERE id = 1"
        )
        watermark = fed_cur.fetchone()

        if watermark:
            last_processed_at = watermark[0]
        else:
            # No watermark yet — use configurable initial value
            default_initial = (
                datetime.now(timezone.utc) - timedelta(days=7)
            ).isoformat()
            last_processed_at = Variable.get(
                "federation_initial_watermark", default_var=default_initial
            )

        logging.info(f"Starting watermark: {last_processed_at}")

        total_articles = 0
        total_queued = 0
        batch_num = 0

        while True:
            batch_num += 1
            articles = govbr_hook.get_records(
                """
                SELECT n.unique_id, n.title, n.content, n.url, n.image_url,
                       n.tags, n.published_at, n.created_at,
                       n.agency_key, n.theme_l1_id, t.code as theme_code
                FROM news n
                LEFT JOIN themes t ON n.theme_l1_id = t.id
                WHERE n.created_at > %s
                ORDER BY n.created_at ASC
                LIMIT %s
                """,
                parameters=[last_processed_at, BATCH_SIZE],
            )

            if not articles:
                logging.info(f"No more articles after batch {batch_num - 1}.")
                break

            # Build all queue rows for this batch
            rows = []
            max_created_at = None

            for row in articles:
                (
                    unique_id, title, content, url, image_url,
                    tags, published_at, created_at,
                    agency_key, _theme_l1_id, theme_code,
                ) = row

                news_payload = json.dumps({
                    "unique_id": unique_id,
                    "title": title,
                    "content_html": content,
                    "summary": None,
                    "image_url": image_url,
                    "tags": tags or [],
                    "published_at": published_at.isoformat() if published_at else None,
                    "canonical_url": url,
                })

                actors = ["portal"]
                if agency_key:
                    actors.append(agency_key)
                if theme_code:
                    actors.append(f"tema-{theme_code}")

                for actor in actors:
                    rows.append((unique_id, actor, news_payload))

                if max_created_at is None or created_at > max_created_at:
                    max_created_at = created_at

            # Single batch INSERT
            execute_values(
                fed_cur,
                """INSERT INTO ap_publish_queue
                       (news_unique_id, actor_identifier, news_payload)
                   VALUES %s
                   ON CONFLICT (news_unique_id, actor_identifier) DO NOTHING""",
                rows,
                template="(%s, %s, %s::jsonb)",
            )

            # Update watermark
            if max_created_at:
                fed_cur.execute(
                    """INSERT INTO ap_sync_watermark
                           (id, last_processed_at, last_run_at, articles_queued)
                       VALUES (1, %s, NOW(), %s)
                       ON CONFLICT (id) DO UPDATE SET
                           last_processed_at = EXCLUDED.last_processed_at,
                           last_run_at = EXCLUDED.last_run_at,
                           articles_queued = EXCLUDED.articles_queued""",
                    [max_created_at, len(rows)],
                )
                last_processed_at = max_created_at

            fed_conn.commit()

            total_articles += len(articles)
            total_queued += len(rows)

            logging.info(
                f"Batch {batch_num}: {len(articles)} articles, "
                f"{len(rows)} queued, watermark={max_created_at}"
            )

            if len(articles) < BATCH_SIZE:
                break

        fed_cur.close()
        fed_conn.close()

        logging.info(
            f"Done: {total_articles} articles, "
            f"{total_queued} queue entries, {batch_num} batches"
        )
        return {"articles": total_articles, "queued": total_queued}

    @task
    def trigger_publish(enqueue_result: dict) -> dict:
        """Call /trigger-publish on the federation web service."""
        if enqueue_result.get("queued", 0) == 0:
            logging.info("Nothing to publish, skipping trigger.")
            return {"skipped": True}

        import requests

        web_url = Variable.get("federation_web_url")
        auth_token = Variable.get("federation_auth_token")

        logging.info(f"Triggering publish at {web_url}/trigger-publish")
        resp = requests.post(
            f"{web_url}/trigger-publish",
            headers={"Authorization": f"Bearer {auth_token}"},
            timeout=60,
        )
        resp.raise_for_status()
        result = resp.json()
        logging.info(
            f"Publish result: processed={result.get('processed')}, "
            f"published={result.get('published')}, failed={result.get('failed')}"
        )
        return result

    # Task flow
    result = detect_and_enqueue()
    trigger_publish(result)


dag_instance = federation_publish_dag()
