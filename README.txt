SPENDWISE — OFFLINE-FIRST MULTI-USER MONEY TRACKER

What is included
- index.html / api-client.js: responsive app, offline local storage, themes, debts, purchase planner, and reports
- server.js: shared Node.js API handler and optional local development server
- api/[...path].js: Vercel serverless API entry point
- vercel.json: Vercel function configuration
- .env.example: local server configuration template
- supabase.sql: private per-account JSON data table and row-level security
- manifest.json / sw.js / give-money.png: installable offline app and supplied brand icon

Deploy to Vercel
1. Push this project to a GitHub repository. Keep `.env` out of Git.
2. In Vercel, choose Add New Project and import the repository. The project uses Vercel's static file hosting and the `api/[...path].js` serverless function; do not configure it as a long-running custom server.
3. Add these Environment Variables in Vercel Project Settings for Production (and Preview if needed):
   - SUPABASE_URL: your Supabase Project URL
   - SUPABASE_ANON_KEY: your Supabase public anon / publishable key
   - SESSION_SECRET: a unique random secret of at least 32 characters
   - COOKIE_SECURE: true
   - NODE_ENV: production
4. In the Supabase SQL Editor, run `supabase.sql`. In Supabase Authentication, enable Email sign-ups. Set the Supabase Site URL and allowed redirect URLs to the Vercel app URL, including its production domain.
5. Deploy. After setting or changing environment variables, redeploy. Open the deployed HTTPS URL and create an account.
6. Verify `/api/health` on the deployed domain returns `{"ok":true,"accountsConfigured":true}`.

Never use a Supabase service-role / secret key in this app. The server uses the signed-in user's access token with row-level security. Account session tokens are stored in an encrypted HttpOnly cookie. For email-confirmation sign-ups, configure Supabase email delivery and ask users to confirm their email before signing in.

Run locally
1. Install Node.js 20 or newer.
2. Create a Supabase project and run `supabase.sql` in its SQL Editor.
3. Copy `.env.example` to `.env`.
4. Set SUPABASE_URL and SUPABASE_ANON_KEY in `.env`, then set SESSION_SECRET to a unique random value (for example, run `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`).
5. Run `npm start` and open http://localhost:3000. Keep the server running while you use the app.

Sign-in and first visit
The app opens at its sign-in/create-account screen. Returning users with a valid session go straight to their synced app. Choose “Continue offline on this device” to use local-only mode without an account. Your name is optional and, if entered in Settings, is saved with your data so it is not requested again on later visits. To sync across devices, create an account or sign in.

Offline use
Open the app online once so the service worker can cache its interface and logo. After that, the app shell and local records remain available offline; adding or editing transactions, budgets, goals, debts, and wishlist purchase plans saves to that device. Wishlist plans are included in JSON backup/import and signed-in account sync. When online again, signed-in changes sync with the account. A new device must connect once and sign in before it can download account data. Export a JSON backup in Settings as another recovery option.

Wishlist & Purchase Planner
Use the Planner page to create purchase plans with a target budget, savings, priority, and optional date. The planner shows remaining amounts, budget warnings, savings recommendations, upcoming purchase dates, and a monthly plan. Changes are saved locally and remain available offline. The “Can I Afford It?” result is an estimate based only on recorded SpendWise income, expenses, and planned purchases; it is not financial advice.

People & debts
Use “People & debts” to record who owes you and whom you owe, along with an amount, optional due date, and note. Mark an item settled when paid. Debt records are included in signed-in sync and PDF reports.

PDF reports
Choose Reports → Download PDF. The app opens a print-ready report with the SpendWise logo, totals, transactions, and outstanding debts. In the print dialog, choose “Save as PDF” (on phones, use the browser's print/share destination that saves a PDF).

Security and launch checks
- Keep `.env` and SESSION_SECRET private. Use HTTPS and COOKIE_SECURE=true in production.
- Do not configure or expose a Supabase service-role key.
- Confirm the `spendwise_data` row-level security policies are active.
- Test account confirmation, sign-in, cross-device sync, offline local edits, and account separation before launch.
- Vercel Functions may scale to zero and have execution limits; the API is stateless and keeps session state in encrypted cookies, so it does not require a persistent server process.

Made by Shadrack Musembi-SpendWise 2026
