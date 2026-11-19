# Kiddie Corner Orders

A phone app for tracking the orders of the Kiddie Corner Instagram page (kids' clothes).
It runs on **Android and iPhone** straight from the phone. You open it once in the browser,
add it to the home screen, and from then on it opens like a normal app, even offline. You don't
need a laptop or a server.

## Features

- **Orders**: customer name, phone, Instagram, address, date, status (New, Confirmed, Shipped, Delivered, Cancelled) and notes.
- **Pieces with photos**: pick several photos at once and each one becomes a piece. Add a name, size, quantity and price for each piece, and the total is calculated for you.
- **Extra costs (Settings)**: set up costs such as shipping, packaging or a COD fee, either as a fixed amount or as a % of the pieces total. Costs marked *Auto* are added to every new order. Inside an order you can switch each cost on or off or change its amount. You can also add a discount.
- **Returning customers**: orders with the same phone number are grouped into one customer, even when the number is written differently (`01012345678`, `+20 101 234 5678` and `00201012345678` all match). When you type a phone number in a new order, the app tells you right away if it's a returning customer and fills in their name.
- **Dashboard**: total sales, average order, customer count, returning-customer %, extra costs collected, sales by month, orders by status, top customers, best-selling pieces, sizes sold, and orders by weekday. You can view it for this month, last month, the last 30 days, this year or all time.
- **Export to Excel (.xlsx)** with 4 sheets: Orders, Pieces, Customers and Monthly summary.
- **Backup / restore**: one JSON file that includes all photos.
- Buttons to call the customer, message them on WhatsApp with the order summary, or copy the summary to paste into an Instagram DM.

## Where is the data stored?

All data, photos included, is stored **on the phone itself** (in the browser's IndexedDB storage).
Nothing is uploaded anywhere. This means:

- Use **Settings → Download full backup** regularly and save the file to Google Drive, iCloud or WhatsApp. If you change or lose your phone, install the app on the new phone and use **Restore from backup**.
- Each phone has its own data. Two phones don't sync with each other.
- Photos are shrunk automatically (to about 200–400 KB each) to save space.

## Putting the app online (one time, free) with GitHub Pages

1. Open this repository on github.com. The app files must be on the `main` branch (merge this branch into `main`).
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Source: Deploy from a branch**, pick **Branch: `main`** and the folder **`/ (root)`**, then click **Save**.
4. After a minute or two the site will be at `https://<your-github-username>.github.io/Kiddie_Corner/`.

> GitHub Pages is free for **public** repositories. A public repository only shows the app's *code*.
> Your orders and customers are never uploaded, so they stay private on your phone.
> If you'd rather keep the repository private, you can upload the folder to
> [Netlify Drop](https://app.netlify.com/drop) or Cloudflare Pages for free instead.

## Installing on the phone

**iPhone (Safari):** open the link, tap the **Share** button, then tap **Add to Home Screen**.
Always open the app from the home-screen icon, because iPhone keeps the home-screen app's data separate from Safari's.

**Android (Chrome):** open the link, tap the **⋮** menu, then tap **Install app** (or **Add to Home screen**).

## Updating the app

Change the files and push to `main`. Also change `VERSION` in `sw.js` (for example to `kc-v2`) so
phones download the new version. The next time the app is opened with internet, it updates itself.
Your data is not affected.

## Technical notes

- Plain HTML, CSS and JavaScript with no build step. `index.html` is the entry point.
- `js/db.js` handles storage (IndexedDB), and `js/app.js` contains the screens and logic.
- `sw.js` is the service worker that lets the app work offline.
- `vendor/xlsx.full.min.js` is [SheetJS](https://sheetjs.com) 0.18.5 (Apache-2.0), used to write the Excel files.
- To run it locally: `python3 -m http.server 8000`, then open http://localhost:8000.
