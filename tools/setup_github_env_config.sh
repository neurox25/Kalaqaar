#!/usr/bin/env bash
set -euo pipefail

# Configure required GitHub repository variables/secrets for environment-aware deploys.
# Usage:
#   tools/setup_github_env_config.sh <owner/repo> <staging_project> <prod_project> <staging_admin_site> <prod_admin_site> <staging_web_site> <prod_web_site> <staging_api_base> <prod_api_base>
#
# Example:
#   tools/setup_github_env_config.sh neurox25/Kalaqaar kalaqaar-stg kalaqaar-prod kalaqaar-admin-stg kalaqaar-admin-prod kalaqaar-web-stg kalaqaar-web-prod https://staging-api.kalaqaar.com https://api.kalaqaar.com

if [[ "${1:-}" == "" || "${9:-}" == "" ]]; then
  echo "Usage: $0 <owner/repo> <staging_project> <prod_project> <staging_admin_site> <prod_admin_site> <staging_web_site> <prod_web_site> <staging_api_base> <prod_api_base>" >&2
  exit 1
fi

REPO="$1"
STAGING_PROJECT="$2"
PROD_PROJECT="$3"
STAGING_ADMIN_SITE="$4"
PROD_ADMIN_SITE="$5"
STAGING_WEB_SITE="$6"
PROD_WEB_SITE="$7"
STAGING_API_BASE="$8"
PROD_API_BASE="$9"

if [[ "$STAGING_PROJECT" == "$PROD_PROJECT" ]]; then
  echo "Staging and production projects must be different." >&2
  exit 1
fi

echo "Setting GitHub repository variables for $REPO..."
gh variable set FIREBASE_PROJECT_STAGING --repo "$REPO" --body "$STAGING_PROJECT"
gh variable set FIREBASE_PROJECT_PROD --repo "$REPO" --body "$PROD_PROJECT"
gh variable set FIREBASE_HOSTING_SITE_ADMIN_STAGING --repo "$REPO" --body "$STAGING_ADMIN_SITE"
gh variable set FIREBASE_HOSTING_SITE_ADMIN_PROD --repo "$REPO" --body "$PROD_ADMIN_SITE"
gh variable set FIREBASE_HOSTING_SITE_WEB_STAGING --repo "$REPO" --body "$STAGING_WEB_SITE"
gh variable set FIREBASE_HOSTING_SITE_WEB_PROD --repo "$REPO" --body "$PROD_WEB_SITE"
gh variable set GCP_PROJECT_STAGING --repo "$REPO" --body "$STAGING_PROJECT"
gh variable set GCP_PROJECT_PROD --repo "$REPO" --body "$PROD_PROJECT"
gh variable set API_BASE_URL_STAGING --repo "$REPO" --body "$STAGING_API_BASE"
gh variable set API_BASE_URL_PROD --repo "$REPO" --body "$PROD_API_BASE"

echo "Done."
echo "Next: set required secrets (repo or environment scoped):"
echo "  - FIREBASE_TOKEN"
echo "  - GCP_WORKLOAD_ID_PROVIDER"
echo "  - GCP_SA_EMAIL"
echo "  - ADMIN_OWNER_UIDS"
