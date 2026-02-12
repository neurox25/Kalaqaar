# CI/CD Overview

This repo includes GitHub Actions for:

- CI (`.github/workflows/ci.yml`):
  - Flutter analyze/tests, Functions lint/tests, Security scan (Trivy)
  - Build validation for Flutter, plus admin and website builds
  - A deploy gate job that confirms readiness on pushes to `main`

- Staging Deploy (`.github/workflows/staging-deploy.yml`):
  - Manual environment deploy (`staging` or `prod`) for Functions/Hosting
  - Uses GitHub Environments (`staging`, `production`) and per-environment deploy lock

- Functions OIDC Deploy (`.github/workflows/deploy-functions-oidc.yml`):
  - Branch-aware deploy (`staging` branch -> staging project, `main` -> prod project)
  - Manual dispatch supports explicit `environment` + function list
  - Uses GitHub Environments and non-overlapping per-environment deploy concurrency

## Required GitHub Secrets

- `FIREBASE_TOKEN`: CI token from `firebase login:ci` with least privileges.
- `GCP_SA_KEY` (optional): Base64-encoded GCP service account key for advanced workflows.
- `GCP_WORKLOAD_ID_PROVIDER`: Workload Identity provider resource for OIDC auth.
- `GCP_SA_EMAIL`: Service account used by deployment workflows.
- `ADMIN_OWNER_UIDS`: Optional admin UID bootstrap value for Functions deploy.

## Required GitHub Variables (Environment Separation)

- `FIREBASE_PROJECT_STAGING`
- `FIREBASE_PROJECT_PROD`
- `FIREBASE_HOSTING_SITE_ADMIN_STAGING`
- `FIREBASE_HOSTING_SITE_ADMIN_PROD`
- `FIREBASE_HOSTING_SITE_WEB_STAGING`
- `FIREBASE_HOSTING_SITE_WEB_PROD`
- `GCP_PROJECT_STAGING`
- `GCP_PROJECT_PROD`
- `API_BASE_URL_STAGING`
- `API_BASE_URL_PROD`

Deploy workflows now fail fast if required environment variables are missing.
Deploy workflows also hard-fail if staging/prod are configured to the same GCP/Firebase project.

## GitHub Environment Setup (Required)

Create two GitHub Environments in repo settings:

- `staging`
- `production`

Recommended protections:

- `production`: required reviewers (release owners), wait timer, restricted deployment branches (`main` only).
- `staging`: optional reviewer gate, restricted branches (`staging` + manual dispatch).

Manual production dispatch now requires explicit confirmation input:

- `confirm_production=DEPLOY_PROD`

Store environment-scoped secrets where possible:

- `FIREBASE_TOKEN`
- `GCP_WORKLOAD_ID_PROVIDER`
- `GCP_SA_EMAIL`
- `ADMIN_OWNER_UIDS`

This ensures staging and production can use different credentials without changing workflow files.

## One-Command Variable Setup

Use the helper script to set all required repository variables:

```bash
tools/setup_github_env_config.sh <owner/repo> <staging_project> <prod_project> <staging_admin_site> <prod_admin_site> <staging_web_site> <prod_web_site> <staging_api_base> <prod_api_base>
```

Example:

```bash
tools/setup_github_env_config.sh neurox25/Kalaqaar kalaqaar-stg kalaqaar-prod kalaqaar-admin-stg kalaqaar-admin-prod kalaqaar-web-stg kalaqaar-web-prod https://staging-api.kalaqaar.com https://api.kalaqaar.com
```

If you use `GCP_SA_KEY`, remember to write it to a file and set `GOOGLE_APPLICATION_CREDENTIALS` at runtime:

```bash
echo "$GCP_SA_KEY" | base64 -d > $RUNNER_TEMP/gcp_sa.json
export GOOGLE_APPLICATION_CREDENTIALS=$RUNNER_TEMP/gcp_sa.json
```

## Current Activation Checklist

1. Ensure GitHub Environments exist:
   - `staging` (branch policy: `staging`)
   - `production` (branch policy: `main`, required reviewers)
2. Set required repository variables using `tools/setup_github_env_config.sh`.
3. Set required secrets (`FIREBASE_TOKEN`, `GCP_WORKLOAD_ID_PROVIDER`, `GCP_SA_EMAIL`, `ADMIN_OWNER_UIDS`).
4. Run manual staging deploy first; verify smoke checks pass.
5. Run manual production deploy with:
   - `environment=prod`
   - `confirm_production=DEPLOY_PROD`

## Local tasks

- Build admin panel: VS Code task "Build apps/admin (subfolder)" or `npm --prefix apps/admin run build`.
- Build website: VS Code task for website or `npm --prefix apps/web run build`.
