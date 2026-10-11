function decodeBase64(input) {
  if (!input) return '';
  try {
    return Buffer.from(input, 'base64').toString('utf8');
  } catch (e) {
    return '';
  }
}

function isEmailString(s) {
  if (!s) return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(s);
}

function profileUpdates(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const updates = {};
  for (const field of ['name', 'address', 'phone']) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== 'string' || body[field].length > 500) return null;
      updates[field] = body[field].trim();
    }
  }
  if (body.theme !== undefined) {
    if (!['light', 'dark'].includes(body.theme)) return null;
    updates.theme = body.theme;
  }
  if (body.notifications !== undefined) {
    if (typeof body.notifications !== 'boolean') return null;
    updates.notifications = body.notifications;
  }
  return updates;
}

module.exports = { decodeBase64, isEmailString, profileUpdates };
