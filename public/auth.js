// Lightweight client auth helper using Firebase JS SDK v9 compat for simplicity
// Loads config from /api/firebase-config and sets up helpers to get ID token.

window.SCBAuth = (function(){
  let initialized = false;
  let initPromise = null;
  let authReadyPromise = null;

  async function ensureInit(){
    if (initialized) return true;
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        if (!window.firebase || !window.firebase.apps) {
          // Load compat SDKs dynamically if not present
          await loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
          await loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js');
        }
        const res = await fetch('/api/firebase-config');
        if (!res.ok) throw new Error('Unable to load sign-in configuration');
        const cfg = await res.json();
        if (!cfg.apiKey || !cfg.projectId || !cfg.authDomain) throw new Error('Sign-in is not configured. Set the Firebase web app variables on the server.');
        if (!firebase.apps.length) {
          firebase.initializeApp(cfg);
        }
        // Create a one-time promise that resolves when initial auth state is known
        if (!authReadyPromise) {
          authReadyPromise = new Promise((resolve) => {
            const unsub = firebase.auth().onAuthStateChanged(() => { try { unsub(); } catch(_){} resolve(true); });
          });
        }
        initialized = true;
        return true;
      } catch (e) {
        initPromise = null;
        console.error('Failed to init Firebase client', e);
        throw e;
      }
    })();
    return initPromise;
  }

  function loadScript(src){
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      const timer = setTimeout(() => { s.remove(); reject(new Error('Sign-in library could not load. Check your connection.')); }, 10000);
      s.src = src; s.async = true;
      s.onload = () => { clearTimeout(timer); resolve(); };
      s.onerror = () => { clearTimeout(timer); s.remove(); reject(new Error('Sign-in library unavailable')); };
      document.head.appendChild(s);
    });
  }

  async function signIn(email, password){
    await ensureInit();
    const cred = await firebase.auth().signInWithEmailAndPassword(email, password);
    const token = await cred.user.getIdToken();
    try { localStorage.setItem('authToken', token); } catch(e) {}
    try { localStorage.setItem('uid', cred.user.uid); } catch(e) {}
    try { localStorage.setItem('email', cred.user.email || email); } catch(e) {}
    const setup = await authFetch('/api/profile/' + encodeURIComponent(cred.user.uid), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
    if (!setup.ok) throw new Error('Signed in, but profile setup failed. Please try again.');
    return { uid: cred.user.uid, email: cred.user.email, token };
  }

  async function signUp(email, password){
    await ensureInit();
    const cred = await firebase.auth().createUserWithEmailAndPassword(email, password);
    const token = await cred.user.getIdToken();
    try { localStorage.setItem('authToken', token); } catch(e) {}
    try { localStorage.setItem('uid', cred.user.uid); } catch(e) {}
    try { localStorage.setItem('email', cred.user.email || email); } catch(e) {}
    // Create initial profile doc on server
    try {
      const profileResponse = await authFetch(`/api/profile/${encodeURIComponent(cred.user.uid)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: '',
          email: cred.user.email || email,
          name: '',
          phone: '',
          role: 'user',
          uid: cred.user.uid
        })
      });
      if (!profileResponse.ok) throw new Error('Account created, but profile setup failed. Sign in again to retry.');
    } catch (error) { throw error; }
    return { success: true, uid: cred.user.uid, user: cred.user.email };
  }

  async function signOut(){
    await ensureInit();
    try { await firebase.auth().signOut(); } catch (e) {}
  try { localStorage.removeItem('authToken'); localStorage.removeItem('uid'); localStorage.removeItem('email'); } catch(e) {}
  }

  async function getToken(){
    await ensureInit();
  if (authReadyPromise) { try { await authReadyPromise; } catch (_) {} }
  const user = firebase.auth().currentUser;
    if (!user) return null;
    return user.getIdToken(/* forceRefresh */ false);
  }

  async function authFetch(input, init){
    const token = await getToken();
    const headers = new Headers((init && init.headers) || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  }

  function getEmailSync(){
    try { const e = localStorage.getItem('email'); if (e) return e; } catch(e) {}
    try { const u = firebase.auth().currentUser; return (u && u.email) || ''; } catch(e) { return ''; }
  }

  async function ready(){ await ensureInit(); if (authReadyPromise) { try { await authReadyPromise; } catch(_) {} } return true; }

  return { ensureInit, signIn, signUp, signOut, getToken, fetch: authFetch, getEmailSync, ready };
})();
