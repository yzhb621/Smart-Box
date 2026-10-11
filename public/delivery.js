(() => {
  const message = document.getElementById('message');
  const confirm = document.getElementById('confirm');
  let saved = false;
  let details;
  try {
    const params = new URLSearchParams(location.search);
    const email = atob(params.get('e') || '');
    const code = params.get('c');
    const areaId = atob(params.get('a') || '');
    const serialNumber = atob(params.get('s') || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(atob(code || '')) || !/^\d{4}$/.test(areaId) || !/^\d{1,8}$/.test(serialNumber)) throw new Error('Invalid delivery link. Generate a new QR code.');
    details = {email,code,areaId,serialNumber};
    message.textContent = 'Sign in as the recipient or an authorised courier before confirming delivery for ' + email;
    confirm.disabled = false;
  } catch (error) { message.textContent = error.message; }
  confirm.addEventListener('click', async () => {
    confirm.disabled = true;
    try {
      if (!await SCBAuth.getToken()) throw new Error('Please sign in on the home page, then return to this delivery link.');
      const config = await SCB.emailConfig();
      if (!config.pickupTemplateId) throw new Error('Pickup email template is not configured.');
      if (!saved) {
        const response = await SCBAuth.fetch('/api/profile/' + encodeURIComponent(details.email));
        if (!response.ok) throw new Error('Unable to access recipient. Check the recipient account and courier role.');
        const profile = await response.json();
        if (!profile.uid) throw new Error('Recipient account not found.');
        const record = await SCBAuth.fetch('/api/parcels', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({recipientId:profile.uid,qrKeyId:details.code,areaId:details.areaId,postCode:details.areaId,serialNumber:details.serialNumber,status:'delivered',createdAt:'FIREBASE_TIMESTAMP',deliveredAt:'FIREBASE_TIMESTAMP'})});
        if (!record.ok) throw new Error('Delivery could not be saved. No email was sent.');
        saved = true;
      }
      const url = new URL('/qr', location.origin);
      url.searchParams.set('c', details.code);
      await emailjs.send(config.serviceId, config.pickupTemplateId, {email:details.email,passcode:url.href});
      message.textContent = 'Delivery saved and pickup email sent.';
    } catch (error) {
      message.textContent = (saved ? 'Delivery saved. Email pending: ' : '') + error.message;
      confirm.disabled = false;
    }
  });
})();
