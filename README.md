Library Room Booker

Quickstart

1. Copy `.env.example` to `.env` and fill in credentials.
2. Install deps and browsers:

   npm install
   npm run install-browsers

3. Run the script with a natural language request:

   node scripts/book-room.js "book a room for 6-8pm on wednesday march 4"

Notes
- The script uses Playwright UI automation. There is no public API for reservations.
- You will likely need to inspect the site and update a few selectors in `scripts/book-room.js` under the "CUSTOMIZE SELECTORS" section.
- If the site requires CAPTCHA/MFA during login, the script will pause and ask you to complete login manually in the browser window.

This also uses a dockerized version of Playwright, so you can run it in a container if you prefer. See the Docker section below