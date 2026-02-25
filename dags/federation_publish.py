"""
DAG para detectar novas noticias e enfileirar para publicacao via ActivityPub.

Executa a cada 10 minutos. Le watermark do banco federation,
consulta novas noticias no govbrnews, insere na fila de publicacao
com payload completo, e dispara /trigger-publish no federation server.
"""

import json
import logging
from datetime import datetime, timedelta

from airflow.decorators import dag, task
from airflow.models import Variable
from airflow.providers.postgres.hooks.postgres import PostgresHook


@dag(
    dag_id="federation_publish",
    description="Detecta novas noticias e enfileira para publicacao ActivityPub",
    schedule="*/10 * * * *",
    start_date=datetime(2025, 1, 1),
    catchup=False,
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
    def detect_new_articles() -> list:
        """Read watermark from federation DB, query new articles from govbrnews."""
        govbr_hook = PostgresHook(postgres_conn_id="postgres_default")
        fed_hook = PostgresHook(postgres_conn_id="federation_postgres")

        # Read watermark
        watermark = fed_hook.get_first(
            "SELECT last_processed_at FROM ap_sync_watermark WHERE id = 1"
        )
        last_processed_at = watermark[0] if watermark else "1970-01-01T00:00:00+00:00"
        logging.info(f"Watermark: last_processed_at = {last_processed_at}")

        # Query new articles
        articles = govbr_hook.get_records(
            """
            SELECT n.unique_id, n.title, n.content, n.url, n.image_url,
                   n.tags, n.published_at, n.created_at,
                   n.agency_key, n.theme_l1_id, t.code as theme_code
            FROM news n
            LEFT JOIN themes t ON n.theme_l1_id = t.id
            WHERE n.created_at > %s
            ORDER BY n.created_at ASC
            LIMIT 500
            """,
            parameters=[last_processed_at],
        )

        logging.info(f"Found {len(articles)} new articles since {last_processed_at}")
        return articles

    @task
    def enqueue_articles(articles: list) -> dict:
        """Insert queue rows with news_payload for each actor mapping."""
        if not articles:
            logging.info("No new articles to enqueue.")
            return {"queued": 0}

        fed_hook = PostgresHook(postgres_conn_id="federation_postgres")

        max_created_at = None
        total_queued = 0

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

            # Determine target actors
            actors = ["portal"]
            if agency_key:
                actors.append(agency_key)
            if theme_code:
                actors.append(f"tema-{theme_code}")

            for actor in actors:
                fed_hook.run(
                    """
                    INSERT INTO ap_publish_queue (news_unique_id, actor_identifier, news_payload)
                    VALUES (%s, %s, %s::jsonb)
                    ON CONFLICT (news_unique_id, actor_identifier) DO NOTHING
                    """,
                    parameters=[unique_id, actor, news_payload],
                )
                total_queued += 1

            if max_created_at is None or created_at > max_created_at:
                max_created_at = created_at

        # Update watermark
        if max_created_at:
            fed_hook.run(
                """
                INSERT INTO ap_sync_watermark (id, last_processed_at, last_run_at, articles_queued)
                VALUES (1, %s, NOW(), %s)
                ON CONFLICT (id) DO UPDATE SET
                    last_processed_at = EXCLUDED.last_processed_at,
                    last_run_at = EXCLUDED.last_run_at,
                    articles_queued = EXCLUDED.articles_queued
                """,
                parameters=[max_created_at, total_queued],
            )

        logging.info(f"Enqueued {total_queued} queue entries for {len(articles)} articles")
        return {"queued": total_queued}

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
    articles = detect_new_articles()
    result = enqueue_articles(articles)
    trigger_publish(result)


dag_instance = federation_publish_dag()
