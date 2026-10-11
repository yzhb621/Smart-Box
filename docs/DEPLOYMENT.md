# Deployment and end-to-end verification

## Cloud

1. Configure the variables from `.env.example`. Use Firebase Admin and Firebase web configuration from the same project. Enable Email/Password sign-in and Firestore.
2. Deploy a preview from the PR branch with Node.js 22 or newer. Install with `npm ci`. Keep `NODE_ENV` set to production.
3. Verify `/health`, `/home`, `/profile`, `/history`, `/qr` and `/simulator/` load. A health response verifies the process, not database access.
4. Register a test account. Confirm its `users/{uid}` record exists and cannot set its own role. Sign out and sign back in.
5. Assign a dedicated test courier via trusted Firebase administration. Confirm an ordinary account cannot read another profile or administer boxes.
6. Configure EmailJS public key, service and two templates. Set `SCB_BASE_URL` to the deployed HTTPS origin for server-generated pickup links. Configure EmailJS to permit the server REST API; use `EMAILJS_PRIVATE_KEY` if your account requires it. Keep the private key server-only. Registration continues to use the browser template. Templates use `email` and `passcode` parameters. See https://www.emailjs.com/docs/rest-api/send/.
7. Complete a simulated delivery. Verify one parcel record, a working pickup email link, parcel history and correct postcode/serial. Confirm the same delivery twice, concurrently and after a reload: only one document should exist. Test an email rejection, then retry from the delivery page or history. Test a timeout: it should remain uncertain rather than sending again automatically. Check provider history before using the admin notification-resolution endpoint.
8. Configure Firebase Authentication authorised domains for the preview and production origins.

## Raspberry Pi

Export `SCB_BASE_URL`, `SCB_POST_CODE` and `SCB_SERIAL` in the device shell. `.env` is not automatically loaded by Python.

Run `sudo bash py/setup/setup_pi.sh` from the repository root. Activate `py/venv`, test the camera using `py/dev/qr_scan.py`, then start `py/app.py` after checking actuator wiring and pin assignments.

Verify delivery QR generation, a valid pickup, a wrong code, expiration, reset and actuator behaviour. Use a network-reachable HTTPS deployment URL rather than localhost when the QR is scanned from another device.

## Controller identity and recovery

Set `SCB_ID_TOKEN_FILE` to a private local file containing a current Firebase ID token for the recipient or original delivery operator. The controller rereads the file on each request. Never use an Admin service account in the controller or commit the token. An expired token blocks cloud verification and requires renewed sign-in; unattended credential renewal has not been provisioned.

The complete delivery QR is saved to `SCB_QR_IMAGE` (default `/tmp/scb-delivery.png`). Show this on an external screen. A full URL QR cannot reliably fit the 128x64 OLED; the OLED shows status rather than a cropped code.

Controller state is saved to `SCB_STATE_FILE` (default `py/.scb-state.json`, permissions 0600). Keep that file on persistent storage. An opened parcel with failed cloud synchronization is retried on restart or button press, without another actuator command. Once pickup is reserved, completion may be retried after the code expiry by the same identity.

If power or a driver failure interrupts opening, the controller pauses. Stop it and physically inspect the lock. Run `python py/recover.py --confirmed-opened` if it opened, or `python py/recover.py --confirmed-still-locked` if it did not, then restart. These commands record a human-observed state; no software test can prove the latch position without a physical sensor.

## Notification reconciliation

Pickup emails have persisted `pending`, `sending`, `sent` or `uncertain` state. A Firestore transaction prevents concurrent dispatch and enforces the provider rate limit. Network ambiguity or a crashed sender requires checking EmailJS delivery history. An administrator can POST `{"providerOutcome":"sent"}` or `{"providerOutcome":"not_sent"}` to `/api/parcels/:id/notification-resolution` with their Firebase ID token. Only `not_sent` enables another attempt. Do not guess the outcome. Pending messages are retried by explicit requests; no background scheduler is provisioned.

## Acceptance still requiring real services

Automated tests use mocked Firebase, email responses, GPIO and camera. They verify application logic and recovery ordering. Real Firestore transaction behaviour, deployment file inclusion, EmailJS account settings, camera/display readability and actuator wiring require a preview deployment and the actual Pi. Repository changes do not install credentials or prove those external systems work.
