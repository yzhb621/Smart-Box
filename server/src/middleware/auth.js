const admin = require('../config/firebaseAdmin');

// Verify Authorization: Bearer <idToken>; attach req.user = { uid, email }
async function authenticateFirebase(req, res, next) {
  try {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing Authorization Bearer token' });
    }
    const idToken = authHeader.slice('Bearer '.length).trim();
    if (!idToken) return res.status(401).json({ error: 'Invalid token' });

    if (!admin || typeof admin.auth !== 'function') {
      return res.status(500).json({ error: 'Auth service unavailable' });
    }

    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = { uid: decoded.uid, email: decoded.email || null, claims: decoded };
    if (!decoded.role) {
      const profile = await admin.firestore().collection('users').doc(decoded.uid).get();
      if (profile.exists) req.user.claims.role = profile.data().role || 'user';
    }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized', detail: e && e.message ? e.message : String(e) });
  }
}

// Ensure current user has role (from custom claims or Firestore users doc)
function requireRole(requiredRole) {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.uid) return res.status(401).json({ error: 'Unauthorized' });

      // Prefer custom claim `role`
      const roleFromClaims = req.user.claims && req.user.claims.role;
      if (roleFromClaims === requiredRole) return next();

      // Fallback: check Firestore users/{uid}.role
      try {
        const db = admin.firestore();
        const snap = await db.collection('users').doc(req.user.uid).get();
        const data = snap.exists ? snap.data() : null;
        if (data && data.role === requiredRole) return next();
      } catch (_) {}

      return res.status(403).json({ error: 'Forbidden: insufficient role' });
    } catch (e) {
      return res.status(500).json({ error: 'Role check failed', detail: e && e.message ? e.message : String(e) });
    }
  };
}

module.exports = { authenticateFirebase, requireRole };
