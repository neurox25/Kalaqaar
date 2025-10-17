/*
Standalone script to seed a sample verified artist into Firestore.
Usage:
  1. Set GOOGLE_APPLICATION_CREDENTIALS to the path of a service-account JSON with Firestore admin permission.
  2. node scripts/seed_sample_artist.js

This script writes to `artists/{artistId}` and marks it as verified/visible for SEO testing.
*/

const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

async function main() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('ERROR: Set GOOGLE_APPLICATION_CREDENTIALS to a service account JSON with Firestore admin perms.');
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });

  const db = admin.firestore();

  const id = 'test-artist-' + Math.floor(Math.random() * 9000 + 1000);
  const referralId = 'ART-' + Math.floor(Math.random() * 9000 + 1000);

  const doc = {
    artistId: id,
    referralId,
    displayName: 'Test Photographer ' + id,
    name: 'Test Artist',
    city: 'Mumbai',
    primaryCategory: 'Photographer',
    category: 'Photographer',
    pseudoId: referralId,
    priceStart: 15000,
    verified: true,
    visible: true,
    photos: [],
    bio: 'Sample test artist for Kalaqaar SEO and booking flow tests.',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  try {
    await db.collection('artists').doc(id).set(doc);
    console.log('Seeded artist:', id, referralId);
    process.exit(0);
  } catch (err) {
    console.error('Failed to seed:', err);
    process.exit(2);
  }
}

main();
