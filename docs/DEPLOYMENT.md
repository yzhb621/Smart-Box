# Deployment and end-to-end verification

## Cloud

1. Configure the variables from `.env.example`. Use Firebase Admin and Firebase web configuration from the same project. Enable Email/Password sign-in and Firestore.
2. Deploy a preview from the PR branch with Node.js 22 or newer. Install with `npm ci`. Keep `NODE_ENV` set to production.
3. Verify `/health`, `/home`, `/profile`, `/history`, `/qr` and `/simulator/` load. A health response verifies the process, not database access.
4. Register a test account. Confirm its `users/{uid}` record exists and cannot set its own role. Sign out and sign back in.
5. Assign a dedicated test courier via trusted Firebase administration. Confirm an ordinary account cannot read another profile or administer boxes.
6. Configure EmailJS browser public key, service and two templates. Restrict allowed origins in EmailJS. Templates use `email` and `passcode` parameters.
7. Complete a simulated delivery. Verify one parcel record, a working pickup email link, parcel history and correct postcode/serial. Test an email failure and retry on the same page.
8. Configure Firebase Authentication authorised domains for the preview and production origins.

## Raspberry Pi

Export `SCB_BASE_URL`, `SCB_POST_CODE` and `SCB_SERIAL` in the device shell. `.env` is not automatically loaded by Python.

Run `sudo bash py/setup/setup_pi.sh` from the repository root. Activate `py/venv`, test the camera using `py/dev/qr_scan.py`, then start `py/app.py` after checking actuator wiring and pin assignments.

Verify delivery QR generation, a valid pickup, a wrong code, expiration, reset and actuator behaviour. Use a network-reachable HTTPS deployment URL rather than localhost when the QR is scanned from another device.

The controller has no authenticated cloud callback for pickup completion. Firestore will not automatically mark a parcel retrieved when the physical lock opens. Adding this requires a device authentication design and actual hardware/network verification.

## Current limits

Email confirmation and cloud persistence span two services, so they are not an atomic transaction. Same-page retries avoid duplicate saves; refresh-safe deduplication and a server-side email queue are future work. QR codes use Base64 encoding and should be treated as bearer secrets. Physical camera/display readability needs testing on the actual device.
