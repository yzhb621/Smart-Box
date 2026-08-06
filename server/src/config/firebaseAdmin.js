const admin = require('firebase-admin');
const path = require('path');

// If running tests, export a lightweight mock admin to avoid requiring real credentials
if (process.env.NODE_ENV === 'test') {
  module.exports = {
    apps: [],
    initializeApp: () => {},
    credential: { cert: () => ({}) },
    // mock firestore API used by tests and signup path
    firestore: (() => {
      const fn = () => ({
        collection: () => ({
          where: () => ({ get: async () => ({ empty: true, docs: [] }) }),
          doc: () => ({
            get: async () => ({ exists: false }),
            collection: () => ({ add: async () => ({}) }),
            set: async () => ({})
          })
        })
      });
      fn.FieldValue = {
        serverTimestamp: () => ({ _mockedServerTimestamp: true })
      };
      return fn;
    })(),
    // mock auth API for createUser
    auth: () => ({
      createUser: async ({ email, password }) => ({ uid: `test-${Math.random().toString(36).slice(2,9)}`, email })
    })
  };
  // exit early; do not run real initialization
} else {
  // Load dotenv from repository root (assume .env at project root)
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

  const DEBUG_ENV = !!(process.env.DEBUG_ENV && process.env.DEBUG_ENV !== '0');
  if (DEBUG_ENV) console.log('DEBUG_ENV enabled: loaded environment variables for firebaseAdmin');

  function initAdmin() {
    if (admin.apps && admin.apps.length) return admin;
    // Accept multiple env naming conventions (upper/lower/compact)
    const rawPrivate = process.env.PRIVATE_KEY || process.env.private_key || process.env.PRIVATEKEY || process.env.privatekey;
    const privateKey = rawPrivate ? rawPrivate.replace(/\\n/g, '\n') : undefined;
    const projectId = process.env.PROJECT_ID || process.env.project_id;
    const clientEmail = process.env.CLIENT_EMAIL || process.env.client_email;
    const privateKeyId = process.env.PRIVATE_KEY_ID || process.env.private_key_id;
    const clientId = process.env.CLIENT_ID || process.env.client_id;

    if (!projectId || !clientEmail || !privateKey) {
      console.warn('Warning: Firebase admin env variables missing; continuing with a mock admin. Set PROJECT_ID, client_email and private_key in .env to enable real Firebase.');
      // provide a mock admin that prevents startup crashes; route handlers will receive empty results or can handle errors
      return {
        apps: [],
        initializeApp: () => {},
        credential: { cert: () => ({}) },
        firestore: () => ({
          collection: () => ({
            where: () => ({ get: async () => ({ empty: true, docs: [] }) }),
            doc: () => ({ collection: () => ({ add: async () => ({}) }), set: async () => ({}) })
          })
        })
      };
    }

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: projectId,
        clientEmail: clientEmail,
        privateKey: privateKey,
        privateKeyId: privateKeyId,
        clientId: clientId
      })
    });
    return admin;
  }

  module.exports = initAdmin();
}
