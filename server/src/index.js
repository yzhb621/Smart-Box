require('dotenv').config();
const firebase = require('firebase/compat/app');
require('firebase/compat/auth');
const express = require('express');
const app = express();
const path = require('path');
const Client = require('@emailjs/nodejs');
const { createCanvas, loadImage } = require('canvas');
const QRCode = require('qrcode');

// --- Firebase Admin SDK (centralized) ---
const admin = require('./config/firebaseAdmin');
const db = admin.firestore();
const { authenticateFirebase, requireRole } = require('./middleware/auth');

const firebaseConfig = {
    apiKey: process.env.API_KEY,
    authDomain: process.env.AUTH_DOMAIN,
    projectId: process.env.PROJECT_ID,
    storageBucket: process.env.STORAGE_BUCKET,
    messagingSenderId: process.env.MESSAGING_SENDER_ID,
    appId: process.env.APP_ID,
    measurementId: process.env.MEASUREMENT_ID
};
// Note: client will handle auth; server no longer uses client SDK for login
if (process.env.NODE_ENV !== 'test') {
    if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
    }
}

const port = process.env.PORT || 8080;

app.use(express.json());

// Resolve public directory robustly (several possible locations depending on how server is started)
const fs = require('fs');
const candidatePublicDirs = [
    path.join(__dirname, '..', '..', 'public'), // repo-root when running from server/src (server/src -> ../.. -> repo)
    path.join(process.cwd(), '..', 'public'), // when cwd is server
    path.join(process.cwd(), 'public') // when cwd is repo root
];
let publicDir = candidatePublicDirs.find(d => fs.existsSync(d));
if (!publicDir) {
    // fallback to repo-root candidate and warn
    publicDir = path.join(__dirname, '..', '..', 'public');
    console.warn('Warning: public directory not found in candidate locations, defaulting to', publicDir);
}
// Serve register.html as the default index page instead of index.html
app.use(express.static(publicDir, { index: 'register.html' }));

app.get("/", (req, res) => {
    res.sendFile(path.join(publicDir, "register.html"));
});

app.get("/home", (req, res) => {
    res.sendFile(path.join(publicDir, "register.html"));

});

app.get("/profile", (req, res) => {
    res.sendFile(path.join(publicDir, "profile.html"));

});

// Admin page (simple static admin UI)
app.get("/admin", (req, res) => {
    res.sendFile(path.join(publicDir, "admin.html"));

});

app.get("/qr", (req, res) =>{
    res.sendFile(path.join(publicDir, "qr.html"));

})

app.get("/data", (req, res) =>{
    res.sendFile(path.join(publicDir, "data.html"));

})

app.get("/history", (req, res) =>{
    res.sendFile(path.join(publicDir, "history.html"));

})

// Health-check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

app.post("/api/email-key", (req, res) =>{
    res.json({key: process.env.PUBLICKEY});
});

// Public Firebase config for client SDK initialization
app.get('/api/firebase-config', (req, res) => {
    res.json({
        apiKey: process.env.API_KEY,
        authDomain: process.env.AUTH_DOMAIN,
        projectId: process.env.PROJECT_ID,
        storageBucket: process.env.STORAGE_BUCKET,
        messagingSenderId: process.env.MESSAGING_SENDER_ID,
        appId: process.env.APP_ID,
        measurementId: process.env.MEASUREMENT_ID
    });
});


// Get user profile by email
app.get('/api/profile/:email', authenticateFirebase, async (req, res) => {
    try {
        const param = req.params.email;
        const usersRef = db.collection('users');
        let userDoc = null;
        // First search by email
        const snap = await usersRef.where('email', '==', param).get();
        if (!snap.empty) {
            userDoc = snap.docs[0];
        } else {
            // Fallback: treat param as uid
            const asUid = await usersRef.doc(param).get();
            if (asUid.exists) userDoc = asUid;
        }
        if (!userDoc) return res.json({});
        const uid = userDoc.id;
        const profile = userDoc.data();
        // Authorization: if user present and not admin, limit to self
        if (req.user && req.user.claims && req.user.claims.role !== 'admin') {
            const authedEmail = req.user.email || null;
            if (authedEmail && profile && profile.email && authedEmail !== profile.email) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            if (!authedEmail && req.user.uid !== uid) {
                return res.status(403).json({ error: 'Forbidden' });
            }
        }
        profile.uid = uid;
        res.json(profile);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Delete a box by document ID
app.delete('/api/boxes/:id', authenticateFirebase, requireRole('admin'), async (req, res) => {
    try {
        const id = req.params.id;
        if (!id) return res.status(400).json({ error: 'Missing box id' });
        const ref = db.collection('boxes').doc(id);
        const doc = await ref.get();
        if (!doc.exists) return res.status(404).json({ error: 'Box not found' });
        await ref.delete();
        return res.json({ success: true });
    } catch (e) {
        console.error('Failed to delete box:', e);
        res.status(500).json({ error: e.message });
    }
});

// Update user profile by email (find UID first)
app.post('/api/profile/:email', authenticateFirebase, async (req, res) => {
    try {
        const param = req.params.email;
        const usersRef = db.collection('users');
        let uid = null;
        const snap = await usersRef.where('email', '==', param).get();
        if (!snap.empty) {
            uid = snap.docs[0].id;
        } else {
            // fallback: treat as uid
            const asUid = await usersRef.doc(param).get();
            if (asUid.exists) uid = asUid.id;
        }
        if (!uid) return res.status(404).json({ error: 'User not found' });
        // Authorization: only self or admin
        if (req.user && req.user.claims && req.user.claims.role !== 'admin' && req.user.uid !== uid) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        await db.collection('users').doc(uid).set({
            ...req.body,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get user history by email (find UID first, use 'parcels' collection)
app.get('/api/history/:email', authenticateFirebase, async (req, res) => {
    try {
        const param = req.params.email;
        const usersRef = db.collection('users');
        let uid = null;
        const snap = await usersRef.where('email', '==', param).get();
        if (!snap.empty) {
            uid = snap.docs[0].id;
        } else {
            const asUid = await usersRef.doc(param).get();
            if (asUid.exists) uid = asUid.id;
        }
        if (!uid) return res.json([]);
        if (req.user && req.user.claims && req.user.claims.role !== 'admin' && req.user.uid !== uid) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const parcelsSnap = await db.collection('parcels').where('recipientId', '==', uid).get();
        const parcels = parcelsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        // Enrich parcels with area name (from areas collection) and ensure serialNumber field is present
        const areasRef = db.collection('areas');
        const data = await Promise.all(parcels.map(async (p) => {
            let areaName = null;
            try {
                if (p.areaId) {
                    const areaDoc = await areasRef.doc(String(p.areaId)).get();
                    if (areaDoc.exists) {
                        const ad = areaDoc.data();
                        if (ad && ad.area) areaName = ad.area;
                    }
                    if (!areaName) {
                        const aSnap = await areasRef.where('areaCode', '==', String(p.areaId)).limit(1).get();
                        if (!aSnap.empty) {
                            const ad = aSnap.docs[0].data();
                            if (ad && ad.area) areaName = ad.area;
                        }
                    }
                }
            } catch (e) {
                // ignore enrichment errors
            }
            return {
                ...p,
                areaName: areaName || null,
                serialNumber: p.serialNumber || p.serial || null
            };
        }));
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Add history entry by email (find UID first, add to 'parcels' collection)
app.post('/api/history/:email', authenticateFirebase, async (req, res) => {
    try {
        const param = req.params.email;
        const usersRef = db.collection('users');
        let uid = null;
        const snap = await usersRef.where('email', '==', param).get();
        if (!snap.empty) {
            uid = snap.docs[0].id;
        } else {
            const asUid = await usersRef.doc(param).get();
            if (asUid.exists) uid = asUid.id;
        }
        if (!uid) return res.status(404).json({ error: 'User not found' });
        if (req.user && req.user.claims && req.user.claims.role !== 'admin' && req.user.uid !== uid) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        await db.collection('parcels').add({
            ...req.body,
            recipientId: uid,
            date: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Update user profile by uid
app.post('/api/profile/:uid', authenticateFirebase, async (req, res) => {
    try {
        if (req.user && req.user.claims && req.user.claims.role !== 'admin' && req.user.uid !== req.params.uid) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        await db.collection('users').doc(req.params.uid).set({
            ...req.body,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get user history by uid
app.get('/api/history/:uid', authenticateFirebase, async (req, res) => {
    try {
        if (req.user && req.user.claims && req.user.claims.role !== 'admin' && req.user.uid !== req.params.uid) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const snap = await db.collection('users').doc(req.params.uid).collection('history').orderBy('date', 'desc').get();
        const data = snap.docs.map(doc => ({ ...doc.data(), id: doc.id }));
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Add history entry by uid
app.post('/api/history/:uid', authenticateFirebase, async (req, res) => {
    try {
        if (req.user && req.user.claims && req.user.claims.role !== 'admin' && req.user.uid !== req.params.uid) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        await db.collection('users').doc(req.params.uid).collection('history').add({
            action: req.body.action,
            date: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Add new parcel to 'parcels' collection
app.post('/api/parcels', authenticateFirebase, async (req, res) => {
    try {
        const { 
            courierId, 
            createdAt, 
            deliveredAt, 
            deliveryAddress, 
            qrKeyId, 
            recipientId, 
            retrievedAt, 
            status, 
            postCode, 
            serialNumber 
        } = req.body;

        // Normalize serialNumber:
        // - If serialNumber looks like a short seq (numeric <=8) and postCode provided, pad to 8 and prefix postCode -> final 12-digit serial
        // - Else pad numeric serial to 12 digits
        let finalSerial = null;
        if (serialNumber !== undefined && serialNumber !== null) {
            const sRaw = String(serialNumber).replace(/\D/g, '');
            if (postCode && /^[0-9]{1,8}$/.test(sRaw)) {
                const seq8 = sRaw.padStart(8, '0');
                finalSerial = `${postCode}${seq8}`;
            } else if (/^[0-9]+$/.test(sRaw)) {
                finalSerial = sRaw.padStart(12, '0');
            } else {
                finalSerial = String(serialNumber);
            }
        }

        await db.collection('parcels').add({
            courierId,
            createdAt: createdAt === 'FIREBASE_TIMESTAMP' ? admin.firestore.FieldValue.serverTimestamp() : createdAt,
            deliveredAt: deliveredAt === 'FIREBASE_TIMESTAMP' ? admin.firestore.FieldValue.serverTimestamp() : deliveredAt,
            deliveryAddress,
            qrKeyId,
            recipientId,
            retrievedAt,
            status,
            postCode,
            serialNumber: finalSerial
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get boxes (defaults to type 'SCB')
app.get('/api/boxes', authenticateFirebase, async (req, res) => {
    try {
        const boxesRef = db.collection('boxes');
        const filterType = req.query.type || 'SCB';
        const snap = await boxesRef.where('type', '==', filterType).get();
        if (snap.empty) return res.json([]);
        let data = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // For each box, find the most recent parcel
        data = await Promise.all(data.map(async (b) => {
            try {
                const postCode = b.postCode || (b.id ? b.id.split('-')[0] : null);
                if (!postCode) {
                    b.recentDeliveryCreatedAt = null;
                    return b;
                }

                // Find parcels matching this box's serial number
                let found = false;
                try {
                    const serialPart = (b.serialNumber || b.serial || '') + '';
                    let targetSerial = null;
                    const digits = String(serialPart).replace(/\D/g, '');
                    
                    // Construct the target serial based on post code
                    if (digits.length === 8 && postCode) {
                        targetSerial = `${postCode}${digits}`; // 12-digit serial (4 post + 8 seq)
                    } else if (digits.length === 12) {
                        targetSerial = digits;
                    }

                    if (targetSerial) {
                        const seqDigits = digits.replace(/^0+/, '') || digits;
                        try {
                            const pSnap = await db.collection('parcels').where('postCode', '==', postCode).get();
                            if (!pSnap.empty) {
                                const parcels = pSnap.docs.map(d => ({ id: d.id, ...d.data() }));
                                const matches = parcels.filter(d => {
                                    const ps = String(d.serialNumber || d.serial || '').replace(/\D/g, '');
                                    const pnorm = ps.replace(/^0+/, '') || ps;
                                    return pnorm === seqDigits;
                                });
                                if (matches.length) {
                                    matches.sort((a, b) => {
                                        const ta = a.date || a.createdAt || null;
                                        const tb = b.date || b.createdAt || null;
                                        const va = ta && ta.seconds ? ta.seconds * 1000 : (ta ? new Date(ta).getTime() : 0);
                                        const vb = tb && tb.seconds ? tb.seconds * 1000 : (tb ? new Date(tb).getTime() : 0);
                                        return vb - va;
                                    });
                                    const p = matches[0];
                                    b.recentDeliveryCreatedAt = p.createdAt || p.date || null;
                                    found = true;
                                }
                            }
                        } catch (err) {
                            console.warn('box-specific numeric parcel lookup failed', err && err.message ? err.message : err);
                        }
                    }
                } catch (e) {
                    console.warn('Failed box-specific parcel lookup', e && e.message ? e.message : e);
                }

                if (!found) {
                    b.recentDeliveryCreatedAt = null;
                }
            } catch (e) {
                b.recentDeliveryCreatedAt = null;
            }
            return b;
        }));

        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Create a new box with post code and address. Body: { postCode, address: { streetNumber, streetName, city }, locationDescription }
app.post('/api/boxes', authenticateFirebase, requireRole('admin'), async (req, res) => {
    try {
        const { postCode, address, locationDescription } = req.body || {};
        if (!postCode || !/^\d{4}$/.test(postCode)) {
            return res.status(400).json({ error: 'postCode must be 4 digits' });
        }
        if (!address || !address.streetNumber || !address.streetName || !address.city) {
            return res.status(400).json({ error: 'Complete address is required (streetNumber, streetName, city)' });
        }
        if (!locationDescription) {
            return res.status(400).json({ error: 'Location description is required' });
        }

        // Allocate the lowest available seq for the post code area (fill gaps). Use a transaction
        // so concurrent creators will retry and one will win.
        const result = await db.runTransaction(async (tx) => {
            const boxesQuery = db.collection('boxes').where('postCode', '==', postCode);
            const snap = await tx.get(boxesQuery);
            const used = new Set();
            snap.docs.forEach(d => {
                const data = d.data() || {};
                let seq = data.seq;
                if (!seq) {
                    // try parse from id like '0000-00000004'
                    const parts = (d.id || '').split('-');
                    if (parts.length > 1) {
                        const n = parseInt(parts[1], 10);
                        if (!isNaN(n)) seq = n;
                    }
                }
                if (seq && Number.isInteger(seq) && seq > 0) used.add(Number(seq));
            });
            // find lowest missing positive integer starting from 1
            let newSeq = 1;
            while (used.has(newSeq)) newSeq++;

            const serial8 = newSeq.toString().padStart(8, '0');
            const docId = `${postCode}-${serial8}`;
            const boxRef = db.collection('boxes').doc(docId);
            const data = {
                postCode,
                address,
                locationDescription,
                seq: newSeq,
                status: 'Normal',
                description: '',
                serialNumber: serial8,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                type: 'SCB'
            };
            tx.set(boxRef, data);
            return { id: docId, ...data };
        });

        res.json({ success: true, box: result });
    } catch (e) {
        console.error('Failed to create box:', e);
        res.status(500).json({ error: e.message });
    }
});

// Create or update an area document. Body: { areaId: '12', area: 'Location name' }
app.post('/api/areas', authenticateFirebase, requireRole('admin'), async (req, res) => {
    try {
        const { areaId, area } = req.body || {};
        if (!areaId || !/^[0-9]{2}$/.test(String(areaId))) return res.status(400).json({ error: 'areaId must be 2 digits' });
        if (!area || typeof area !== 'string' || !area.trim()) return res.status(400).json({ error: 'area (location) is required' });
        const docRef = db.collection('areas').doc(String(areaId));
        await docRef.set({ area: String(area).trim(), areaCode: String(areaId) }, { merge: true });
        return res.json({ success: true, id: docRef.id });
    } catch (e) {
        console.error('Failed to create area:', e);
        return res.status(500).json({ error: e.message });
    }
});

// Report: update status + description for a specific box
app.post('/api/boxes/report', authenticateFirebase, async (req, res) => {
    try {
        const { status, description, id } = req.body || {};
        const boxesRef = db.collection('boxes');

        // Box ID is required
        if (!id) {
            return res.status(400).json({ error: 'Box ID is required' });
        }

        const ref = boxesRef.doc(id);
        const doc = await ref.get();
        if (!doc.exists) {
            return res.status(404).json({ error: 'Box not found' });
        }

        await ref.update({ 
            status: status || 'Normal', 
            description: description || '' 
        });
        
        return res.json({ success: true, updated: 1 });
    } catch (e) {
        console.error('Failed to report box:', e);
        res.status(500).json({ error: e.message });
    }
});

// Get parcels optionally filtered by postCode (ordered by date or createdAt desc)
app.get('/api/parcels', authenticateFirebase, async (req, res) => {
    try {
        const postCode = req.query.postCode;
        const serialQuery = req.query.serial;
        let parcelsRef = db.collection('parcels');
        
        // If serial query provided, normalize it to stored serial format
        if (serialQuery) {
            let targetSerial = String(serialQuery).replace(/\D/g, '');
            if (postCode && /^[0-9]{1,8}$/.test(targetSerial)) {
                targetSerial = `${postCode}${targetSerial.padStart(8,'0')}`;
            } else {
                targetSerial = targetSerial.padStart(12,'0');
            }
            const snap = await parcelsRef.where('serialNumber', '==', targetSerial).get();
            const data = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            return res.json(data);
        }

        if (postCode) {
            // Fetch parcels for this postCode without orderBy (avoids needing composite indexes), then sort in-memory
            const snap = await parcelsRef.where('postCode', '==', postCode).get();
            let data = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            data.sort((a, b) => {
                const ta = a.date || a.createdAt || null;
                const tb = b.date || b.createdAt || null;
                const va = ta && ta.seconds ? ta.seconds * 1000 : (ta ? new Date(ta).getTime() : 0);
                const vb = tb && tb.seconds ? tb.seconds * 1000 : (tb ? new Date(tb).getTime() : 0);
                return vb - va;
            });
            return res.json(data);
        } else {
            // return recent parcels globally: fetch and sort by createdAt/date
            const snap = await parcelsRef.get();
            let data = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            data.sort((a, b) => {
                const ta = a.date || a.createdAt || null;
                const tb = b.date || b.createdAt || null;
                const va = ta && ta.seconds ? ta.seconds * 1000 : (ta ? new Date(ta).getTime() : 0);
                const vb = tb && tb.seconds ? tb.seconds * 1000 : (tb ? new Date(tb).getTime() : 0);
                return vb - va;
            });
            // limit to 100 most recent
            return res.json(data.slice(0, 100));
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Signup endpoint - create Firebase Auth user via Admin SDK and a Firestore `users` document
app.post("/signup", async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, error: 'Missing email or password' });
    try {
        if (admin && typeof admin.auth === 'function') {
            // Create the user via Admin SDK
            const userRecord = await admin.auth().createUser({ email, password });
            const uid = userRecord.uid;

            // Create a Firestore document under `users/{uid}` with default fields
            await db.collection('users').doc(uid).set({
                address: '',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                email: email,
                name: '',
                phone: '',
                role: 'user',
                uid: uid
            });

            console.log(`Created user ${email} (${uid}) via Admin SDK`);
            return res.json({ success: true, user: email, uid });
        } else {
            // Admin SDK not available (mocked) — don't attempt client auth here
            return res.status(500).json({ success: false, error: 'Firebase Admin not available on server' });
        }
    } catch (error) {
        console.error('Error creating user:', error && error.message ? error.message : error);
        res.status(400).json({ success: false, error: error.message || String(error) });
    }
});

// Note: /login and /logout removed. Client must use Firebase Auth and send ID token in Authorization header.

app.get("/p/", (req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
    if (!req.query || Object.keys(req.query).length === 0) {
        console.log("No query parameters found in request.");
    } else {
        
        const emailID = req.query.e;
        const code = req.query.c;

        const { decodeBase64 } = require('./utils/validators');

        // Validate email
        function isValidEmail(email) {
            var tempE = decodeBase64(email);
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            return emailRegex.test(tempE);
        }

        if (!isValidEmail(emailID)) {
            console.log("Invalid email address.");
            return res.status(400).send("Invalid email.");
        }
    }

});

if (require.main === module) {
    app.listen(port, () => {
        console.log(`Server is running on port ${port}`);
    });
}

module.exports = app;
