# Kalaqaar Website — SEO & Smoke Test Guide

This file documents the environment, how to run a local build, and quick smoke-test commands for the Wedding Season SEO features.

1) Setup
- Copy the example env:

```bash
cp .env.local.example .env.local
# Fill the NEXT_PUBLIC_* Firebase values and NEXT_PUBLIC_FUNCTIONS_BASE_URL
```

2) Build locally

```bash
# from kalaqaar_website
npm ci
npm run build
npm run start
```

3) Smoke tests (replace HOST/BASE where needed)

# Sitemap
curl -I "${NEXT_PUBLIC_SITE_URL:-https://kalaqaar.com}/sitemap.xml"

# Robots
curl -I "${NEXT_PUBLIC_SITE_URL:-https://kalaqaar.com}/robots.txt"

# SEO listing (functions endpoint)
curl "${NEXT_PUBLIC_FUNCTIONS_BASE_URL:-https://asia-south1-kalaqaar-1cd70.cloudfunctions.net}/getArtistsByCategoryCity?category=photographer&city=Mumbai"

# Public artist profile
curl "${NEXT_PUBLIC_FUNCTIONS_BASE_URL:-https://asia-south1-kalaqaar-1cd70.cloudfunctions.net}/getArtistPublicProfile?referralId=<REFERRAL_ID>"

# Generate AI bio (callable)
curl -X POST "${NEXT_PUBLIC_FUNCTIONS_BASE_URL:-https://asia-south1-kalaqaar-1cd70.cloudfunctions.net}/generateArtistBio" -H 'Content-Type: application/json' -d '{"name":"Test Artist","category":"Photographer","city":"Mumbai"}'

# Create booking (callable - requires auth token)
# Use firebase emulator or pass Authorization header for a service account token.

4) Notes
- Ensure Firebase Phone Auth is enabled in the Console for OTP flows.
- Ensure storage bucket is configured in `.env.local` for portfolio uploads to trigger watermark function.
- For local testing against emulators, set NEXT_PUBLIC_FUNCTIONS_BASE_URL to the emulator endpoint (e.g., http://127.0.0.1:5001/<project>/<region>)

5) Seed a sample artist (for staging/test only)

This repository includes a convenience script to seed a single verified, visible artist into Firestore. Use it only in non-production or a dedicated staging project.

Prerequisites:
- A service account JSON with Firestore admin permissions.
- Set the environment variable GOOGLE_APPLICATION_CREDENTIALS to point to that JSON.

Run:

```bash
# from the repo root
node scripts/seed_sample_artist.js
```

Verify the artist is listed via the functions endpoint:

```bash
curl "${NEXT_PUBLIC_FUNCTIONS_BASE_URL:-https://asia-south1-kalaqaar-1cd70.cloudfunctions.net}/getArtistsByCategoryCity?category=Photographer&city=Mumbai"
```
