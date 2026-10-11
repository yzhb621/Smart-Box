const express = require('express');
const { createHash } = require('node:crypto');
const admin = require('../config/firebaseAdmin');
const { authenticateFirebase } = require('../middleware/auth');
const router = express.Router();
const db = admin.firestore();
const timestamp = () => admin.firestore.FieldValue.serverTimestamp();
const allowed = (user, parcel) => user.uid === parcel.recipientId || user.uid === parcel.courierId || user.claims.role === 'admin';
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const wrap = handler => async (req, res) => {
  try { await handler(req, res); }
  catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'Delivery service failed. Please retry.' }); }
};
function validCode(value) {
  return typeof value === 'string' && /^\d{6}$/.test(Buffer.from(value, 'base64').toString('utf8'));
}
function checkPickup(user, parcel, code) {
  if (!allowed(user, parcel)) fail(403, 'Forbidden');
  if (!validCode(code) || parcel.qrKeyId !== code) fail(403, 'Invalid pickup code');
  if (parcel.status === 'retrieved') return;
  if (parcel.status !== 'delivered') fail(409, 'Parcel is not available for pickup');
  if (Date.now() >= parcel.expiresAt && parcel.pickupAuthorizedBy !== user.uid) fail(410, 'Pickup code expired');
}
router.use(authenticateFirebase);
router.post('/parcels', wrap(async (req, res) => {
  const { recipientId, postCode, serialNumber, qrKeyId, deliveryId, expiresAt } = req.body;
  if (typeof recipientId !== 'string' || !recipientId || recipientId.includes('/') || !/^\d{4}$/.test(postCode || '') || !/^\d{1,8}$/.test(String(serialNumber || '')) || !validCode(qrKeyId) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(deliveryId || '') || !Number.isSafeInteger(expiresAt)) fail(400, 'Invalid delivery fields');
  if (req.user.uid !== recipientId && !['courier', 'admin'].includes(req.user.claims.role)) fail(403, 'Courier role required for another recipient');
  const recipient = await db.collection('users').doc(recipientId).get();
  if (!recipient.exists) fail(404, 'Recipient not found');
  if (typeof recipient.data().email !== 'string' || !recipient.data().email.includes('@')) fail(400, 'Recipient email missing');
  const id = createHash('sha256').update(deliveryId).digest('hex');
  const ref = db.collection('parcels').doc(id);
  const finalSerial = postCode + String(serialNumber).padStart(8, '0');
  const result = await db.runTransaction(async tx => {
    const existing = await tx.get(ref);
    if (existing.exists) {
      const parcel = existing.data();
      if (!allowed(req.user, parcel)) fail(403, 'Forbidden');
      if (parcel.recipientId !== recipientId || parcel.serialNumber !== finalSerial || parcel.qrKeyId !== qrKeyId || parcel.expiresAt !== expiresAt) fail(409, 'Delivery link conflicts with an existing record');
      return { duplicate: true, notificationStatus: parcel.notificationStatus };
    }
    if (expiresAt <= Date.now() || expiresAt > Date.now() + 600000) fail(400, 'Delivery link expired or invalid expiry');
    tx.create(ref, { deliveryId, courierId: req.user.uid, recipientId, recipientEmail: recipient.data().email,
      serialNumber: finalSerial, postCode, areaId: postCode, qrKeyId, expiresAt,
      deliveryAddress: recipient.data().address || null, status: 'delivered', retrievedAt: null,
      createdAt: timestamp(), deliveredAt: timestamp(), notificationStatus: 'pending', notificationAttempts: 0 });
    return { duplicate: false, notificationStatus: 'pending' };
  });
  res.json({ success: true, id, ...result });
}));
router.post('/parcels/:id/notify', wrap(async (req, res) => {
  if (!/^[a-f0-9]{64}$/.test(req.params.id)) fail(400, 'Invalid parcel id');
  const ref = db.collection('parcels').doc(req.params.id);
  const rateRef = db.collection('system').doc('email-dispatch');
  const parcel = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) fail(404, 'Parcel not found');
    const data = snap.data();
    if (!allowed(req.user, data)) fail(403, 'Forbidden');
    if (data.notificationStatus === 'sent') return null;
    if (data.status !== 'delivered' || Date.now() >= data.expiresAt) fail(410, 'Pickup is no longer available');
    if (data.notificationStatus === 'uncertain') fail(409, 'Email outcome is uncertain. Check provider delivery history before retrying.');
    if (data.notificationStatus === 'sending') {
      if (data.notificationLeaseUntil > Date.now()) fail(409, 'Email is already being sent');
      tx.update(ref, { notificationStatus: 'uncertain' });
      return { uncertain: true };
    }
    if (!process.env.PUBLICKEY || !process.env.EMAILJS_SERVICE_ID || !process.env.EMAILJS_PICKUP_TEMPLATE_ID || !process.env.SCB_BASE_URL) fail(503, 'Pickup email service is not configured');
    const origin = new URL(process.env.SCB_BASE_URL);
    if (!['https:', 'http:'].includes(origin.protocol)) fail(503, 'Invalid application URL');
    const rate = await tx.get(rateRef);
    if (rate.exists && rate.data().nextAt > Date.now()) fail(429, 'Email service busy. Retry shortly.');
    tx.set(rateRef, { nextAt: Date.now() + 1100 });
    tx.update(ref, { notificationStatus: 'sending', notificationLeaseUntil: Date.now() + 30000, notificationAttempts: (data.notificationAttempts || 0) + 1 });
    return data;
  });
  if (!parcel) return res.json({ success: true, notificationStatus: 'sent' });
  if (parcel.uncertain) fail(409, 'Email outcome is uncertain. Check provider delivery history.');
  const url = new URL('/qr', process.env.SCB_BASE_URL);
  url.searchParams.set('c', parcel.qrKeyId);
  let response;
  try {
    response = await fetch('https://api.emailjs.com/api/v1.0/email/send', { method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service_id: process.env.EMAILJS_SERVICE_ID,
        template_id: process.env.EMAILJS_PICKUP_TEMPLATE_ID, user_id: process.env.PUBLICKEY,
        ...(process.env.EMAILJS_PRIVATE_KEY ? { accessToken: process.env.EMAILJS_PRIVATE_KEY } : {}),
        template_params: { email: parcel.recipientEmail, passcode: url.href } }) });
  } catch (_) {
    await ref.update({ notificationStatus: 'uncertain', notificationLeaseUntil: 0 });
    fail(502, 'Email outcome is uncertain. Check provider delivery history.');
  }
  await ref.update({ notificationStatus: response.ok ? 'sent' : 'pending', notificationLeaseUntil: 0,
    ...(response.ok ? { notificationSentAt: timestamp() } : {}) });
  if (!response.ok) fail(502, 'Email provider rejected the request. Delivery saved; retry notification.');
  res.json({ success: true, notificationStatus: 'sent' });
}));
router.post('/pickups/verify', wrap(async (req, res) => {
  const { deliveryId, qrKeyId } = req.body;
  if (typeof deliveryId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(deliveryId)) fail(400, 'Invalid delivery id');
  const id = createHash('sha256').update(deliveryId).digest('hex');
  const ref = db.collection('parcels').doc(id);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) fail(404, 'Confirm delivery before pickup');
    const parcel = snap.data();
    checkPickup(req.user, parcel, qrKeyId);
    if (parcel.status === 'retrieved') fail(409, 'Parcel already retrieved');
    if (parcel.pickupAuthorizedBy && parcel.pickupAuthorizedBy !== req.user.uid) fail(409, 'Pickup already reserved by another operator');
    if (!parcel.pickupAuthorizedBy) tx.update(ref, { pickupAuthorizedBy: req.user.uid, pickupAuthorizedAt: timestamp() });
  });
  res.json({ success: true, id });
}));
router.post('/parcels/:id/notification-resolution', wrap(async (req, res) => {
  if (req.user.claims.role !== 'admin') fail(403, 'Administrator required');
  if (!/^[a-f0-9]{64}$/.test(req.params.id) || !['sent', 'not_sent'].includes(req.body.providerOutcome)) fail(400, 'Invalid notification resolution');
  const ref = db.collection('parcels').doc(req.params.id);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) fail(404, 'Parcel not found');
    if (snap.data().notificationStatus !== 'uncertain') fail(409, 'Notification does not require resolution');
    tx.update(ref, { notificationStatus: req.body.providerOutcome === 'sent' ? 'sent' : 'pending',
      notificationResolvedBy: req.user.uid, notificationResolvedAt: timestamp() });
  });
  res.json({ success: true });
}));
router.post('/parcels/:id/retrieve', wrap(async (req, res) => {
  if (!/^[a-f0-9]{64}$/.test(req.params.id)) fail(400, 'Invalid parcel id');
  const ref = db.collection('parcels').doc(req.params.id);
  const duplicate = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) fail(404, 'Parcel not found');
    const data = snap.data();
    checkPickup(req.user, data, req.body.qrKeyId);
    if (data.status === 'retrieved') return true;
    if (data.pickupAuthorizedBy !== req.user.uid) fail(409, 'Verify pickup before marking it retrieved');
    tx.update(ref, { status: 'retrieved', retrievedAt: timestamp() });
    return false;
  });
  res.json({ success: true, duplicate });
}));
module.exports = router;
