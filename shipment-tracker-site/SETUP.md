# Shipment Tracker: free website setup

The website has two free parts:

- **Supabase** (supabase.com) stores the shipments, the change log, the files and the accounts.
- **Netlify** (netlify.com) puts the website online at an address such as `flain-shipments.netlify.app`.

Total time: about 20 minutes. You do steps 1–3 once.

## 1. Create the database (Supabase)

1. Go to **supabase.com** → **Start your project** → sign up (free).
2. **New project**. Name: `shipment-tracker`. Choose a database password and keep it safe. Region: the closest one to Kuwait (e.g. *Frankfurt* or *Mumbai*). Click **Create**. Wait about 2 minutes.
3. Left menu → **SQL Editor** → **New query**. Open `supabase/schema.sql`, copy everything, paste, click **Run**. You should see *Success*.
4. **New query** again. Paste everything from `import-shipments.sql` (the file Claude sent you; it is not in GitHub because it holds your business data). Click **Run**. This adds your 388 shipments.
5. Left menu → **Authentication** → **Sign In / Providers** → **Email**: turn **off** "Confirm email" and save. (You approve every new person yourself, and the free plan only sends a few emails per hour.)
6. Left menu → **Project Settings** → **API** (or **Data API**). Copy the **Project URL** and the **anon public** key.

## 2. Connect the website

Open `web/config.js` and replace the two values with what you copied in step 1.6. (Or send both values to Claude and get back a ready folder.) Both values are safe to share: the database rules only let approved people see anything.

## 3. Put it online (Netlify)

1. Go to **app.netlify.com/drop**.
2. Drag the whole `web` folder onto the page. In a few seconds you get a link.
3. Sign up (free) and click **Claim** so the site is kept. In **Site configuration** → **Change site name** you can pick a name like `flain-shipments`.
4. Back in Supabase → **Authentication** → **URL Configuration**: set **Site URL** to your Netlify address (needed for "Forgot password" emails).

## 4. Make yourself the admin

1. Open your website → **Create an account** with your first name, last name, work email and a password.
2. In Supabase → **SQL Editor** → **New query**, run (with your email):

   ```sql
   update public.profiles set role = 'admin' where email = 'YOUR-EMAIL@shopflain.com';
   ```

3. Reload the website. You now see everything, plus the **Team** tab.

## 5. Add your team

Send them the website link. They click **Create an account** (first name, last name, email, password). You open **Team** and click **Approve**. Until then they see only "Waiting for approval".

## What the website protects

- Only approved people can see or change shipments. People waiting for approval, removed people and anyone else on the internet see nothing.
- Every change is written to the change log **by the database itself**, with the person's name and time. Nobody can edit or delete the log or delete a shipment.
- Changing an ETA requires a reason. The first ETA (the promise) is locked; only the admin can change it.
- Total charges = shipping + clearance on new shipments and when costs are changed. Imported totals stay as they were.
- Files (invoice, packing list) up to 10 MB are stored privately; only approved people can open them.
