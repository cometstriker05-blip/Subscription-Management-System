#!/usr/bin/env bash
# Deploys Keel to Google Cloud: Cloud Run for the app, Cloud SQL for Postgres, and
# Secret Manager for the database URL and Gemini key. Safe to run again.
#
#   export PROJECT_ID=your-project
#   export GEMINI_API_KEY=...        # optional
#   bash deploy/gcp.sh
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID to your Google Cloud project}"
REGION="${REGION:-asia-south1}"            # Mumbai, closest to Kochi
INSTANCE="${INSTANCE:-keel-db}"
TIER="${TIER:-db-custom-2-7680}"           # 2 vCPU, 7.5 GB. Stop it after the event to save credit
SERVICE="${SERVICE:-keel}"
DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -hex 16)}"

gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com sqladmin.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com aiplatform.googleapis.com

if ! gcloud sql instances describe "$INSTANCE" >/dev/null 2>&1; then
  gcloud sql instances create "$INSTANCE" --database-version=POSTGRES_17 --edition=ENTERPRISE \
    --tier="$TIER" --region="$REGION" --storage-size=20GB --storage-auto-increase
  gcloud sql databases create keel --instance="$INSTANCE"
  gcloud sql users create keel --instance="$INSTANCE" --password="$DB_PASSWORD"
  CONNECTION=$(gcloud sql instances describe "$INSTANCE" --format='value(connectionName)')
  printf 'postgres://keel:%s@/keel?host=/cloudsql/%s' "$DB_PASSWORD" "$CONNECTION" \
    | gcloud secrets create keel-database-url --data-file=-
fi

CONNECTION=$(gcloud sql instances describe "$INSTANCE" --format='value(connectionName)')
RUNTIME_SA="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"

for role in roles/cloudsql.client roles/secretmanager.secretAccessor roles/aiplatform.user; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$RUNTIME_SA" --role="$role" --condition=None --quiet >/dev/null
done

AI_ENV="GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GOOGLE_CLOUD_LOCATION=global"
SECRETS="DATABASE_URL=keel-database-url:latest"
if [ -n "${GEMINI_API_KEY:-}" ]; then
  gcloud secrets describe keel-gemini-key >/dev/null 2>&1 || printf '%s' "$GEMINI_API_KEY" | gcloud secrets create keel-gemini-key --data-file=-
  SECRETS="$SECRETS,GEMINI_API_KEY=keel-gemini-key:latest"
  AI_ENV="GEMINI_MODEL=gemini-3.8-flash"
fi

gcloud run deploy "$SERVICE" --source . --region="$REGION" --allow-unauthenticated \
  --add-cloudsql-instances="$CONNECTION" --set-secrets="$SECRETS" --set-env-vars="$AI_ENV,DB_POOL_SIZE=20" \
  --cpu=2 --memory=1Gi --min-instances=1 --max-instances=1 --no-cpu-throttling --timeout=900 --session-affinity

URL=$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')
gcloud run services update "$SERVICE" --region="$REGION" --update-env-vars="APP_URL=$URL"

# Loads the demo world through the real engine. Takes a few minutes.
IMAGE=$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(spec.template.spec.containers[0].image)')
gcloud run jobs deploy keel-seed --image="$IMAGE" --region="$REGION" --set-cloudsql-instances="$CONNECTION" \
  --set-secrets="DATABASE_URL=keel-database-url:latest" --set-env-vars="MIGRATIONS_DIR=/app/migrations" \
  --command=node --args=dist-server/db/seed.js,--customers=9000 --cpu=2 --memory=2Gi --task-timeout=1800 --max-retries=0
gcloud run jobs execute keel-seed --region="$REGION" --wait

echo
echo "Keel is live at $URL"
echo "To save credit after the event: gcloud sql instances patch $INSTANCE --activation-policy=NEVER"
