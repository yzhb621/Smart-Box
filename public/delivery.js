(() => {
  const message = document.getElementById('message');
  const confirm = document.getElementById('confirm');
  let saved = false;
  let parcelId;
  let details;
  try {
    const params = new URLSearchParams(location.search);
    const email = atob(params.get('e') || '');
    const code = params.get('c');
    const areaId = atob(params.get('a') || '');
    const serialNumber = atob(params.get('s') || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(atob(code || '')) || !/^\d{4}$/.test(areaId) || !/^\d{1,8}$/.test(serialNumber)) throw new Error('Invalid delivery link. Generate a new QR code.');
    const deliveryId = params.get('d');
    const expiresAt = Number(params.get('t'));
    if (!/^[a-f0-9-]{36}$/i.test(deliveryId || '') || !Number.isSafeInteger(expiresAt)) throw new Error('Generate a new delivery QR code.');
    details = {email,code,areaId,serialNumber,deliveryId,expiresAt};
    message.textContent = 'Sign in as the recipient or an authorised courier before confirming delivery for ' + email;
    confirm.disabled = false;
  } catch (error) { message.textContent = error.message; }
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    try {
      if (!await SCBAuth.getToken()) throw new Error('Please sign in on the home page, then return to this delivery link.');
      if (!saved) {
        const response = await SCBAuth.fetch('/api/profile/' + encodeURIComponent(details.email));
        if (!response.ok) throw new Error('Unable to access recipient. Check the recipient account and courier role.');
        const profile = await response.json();
        if (!profile.uid) throw new Error('Recipient account not found.');
        const record = await SCBAuth.fetch('/api/parcels', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({recipientId:profile.uid,qrKeyId:details.code,areaId:details.areaId,postCode:details.areaId,serialNumber:details.serialNumber,deliveryId:details.deliveryId,expiresAt:details.expiresAt})});
        if (!record.ok) throw new Error((await record.json()).error || 'Delivery could not be saved.');
        parcelId = (await record.json()).id;
        saved = true;
      }
      const sent = await SCBAuth.fetch('/api/parcels/' + parcelId + '/notify', {method:'POST'});
      if (!sent.ok) throw new Error((await sent.json()).error || 'Notification failed.');
      message.textContent = 'Delivery saved and pickup email sent.';
    } catch (error) {
      message.textContent = (saved ? 'Delivery saved. Email pending: ' : '') + error.message;
      confirm.disabled = false;
    }
  });
})();
