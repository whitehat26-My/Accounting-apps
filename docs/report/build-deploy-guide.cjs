/*
 * Builds the shop-PC setup guide PDF — for whichever company is installing it.
 *
 *   node docs/report/build-deploy-guide.cjs
 *   node docs/report/build-deploy-guide.cjs --company "Delima Trading" \
 *        --tagline "kedai & akaun" --folder delima --logo /path/to/their.png
 *
 * Every company that runs its own copy needs this document with its own name
 * on it, its own folder in the commands, and no trace of anybody else's shop —
 * a guide that tells somebody to `cd C:\shahgtech` is a guide they will
 * mistype, and one headed with another company's name reads like it was sent
 * to them by mistake. Defaults reproduce the original Shah G Tech guide
 * exactly, so regenerating without arguments changes nothing.
 *
 * The layout helpers below are deliberately a copy of the ones in
 * build-report.cjs rather than a shared module. Two documents is not yet a
 * library, and extracting one now would mean re-verifying the already-issued
 * technical report for no reader-visible gain. If a third document appears,
 * extract then — that is the point at which the duplication starts to cost.
 */
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..', '..');
const PDFDocument = require(path.join(ROOT, 'apps/api/node_modules/pdfkit'));

/** `--name value` from the command line, or the default. */
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  const value = i > -1 ? process.argv[i + 1] : undefined;
  return value && !value.startsWith('--') ? value : fallback;
}

const COMPANY = arg('company', 'Shah G Tech');
const TAGLINE = arg('tagline', 'shop & books');
/** The folder the app is installed into: `C:\<folder>` throughout the guide. */
const FOLDER = arg('folder', 'shahgtech');
const DIR = `C:\\${FOLDER}`;

/*
 * The cover logo belongs to whoever the guide is for, so it is NOT defaulted
 * for a named company: passing `--company` without `--logo` produces a cover
 * with their name set in type and no mark at all, which is correct. Only the
 * unparameterised Shah G Tech build keeps the bundled wordmark. Putting one
 * shop's logo on another shop's manual is the same mistake the invoices used
 * to make, in a place nobody would think to check.
 */
const NAMED = process.argv.includes('--company');
const LOGO = arg('logo', NAMED ? '' : path.join(ROOT, 'apps/api/src/pdf/wordmark.png'));

const SLUG = COMPANY.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
const OUT = path.join(__dirname, `${SLUG}-Setup-Guide.pdf`);

const BRAND = '#1875BE';
const BRAND_DARK = '#12598f';
const INK = '#18181b';
const MUTED = '#52525b';
const LIGHT = '#a1a1aa';
const RULE = '#e4e4e7';
const ALT = '#f4f4f5';
const GOOD = '#15803d';
const WARN = '#b45309';
const BAD = '#b91c1c';
const CODE_BG = '#0f172a';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 56;
const CONTENT = PAGE_W - M * 2;
const BOTTOM = PAGE_H - 64;

const pdf = new PDFDocument({
  size: 'A4',
  margins: { top: M, bottom: 64, left: M, right: M },
  bufferPages: true,
  info: {
    Title: `${COMPANY} ${TAGLINE} — Setup Guide`,
    Author: COMPANY,
    Subject: 'Running the system on the shop PC, with staff phones on the shop WiFi',
  },
});
pdf.pipe(fs.createWriteStream(OUT));

const toc = [];
const pageIndex = () => pdf.bufferedPageRange().count - 1;

function need(h) {
  if (pdf.y + h > BOTTOM) { pdf.addPage(); pdf.y = M + 14; }
}

function h1(number, title) {
  need(96);
  if (pdf.y > M + 20) pdf.y += 16;
  toc.push({ number, title, page: pageIndex() });
  pdf.fillColor(BRAND).font('Helvetica-Bold').fontSize(9)
    .text(number.startsWith('STEP') ? number : `PART ${number}`, M, pdf.y, { characterSpacing: 1.2 });
  pdf.y += 2;
  pdf.fillColor(INK).font('Helvetica-Bold').fontSize(18).text(title, M, pdf.y, { width: CONTENT });
  pdf.y += 6;
  pdf.moveTo(M, pdf.y).lineTo(M + 46, pdf.y).lineWidth(2.5).strokeColor(BRAND).stroke();
  pdf.y += 12;
  pdf.fillColor(INK).font('Helvetica').fontSize(10);
}

function h2(title) {
  need(56);
  pdf.y += 10;
  pdf.fillColor(INK).font('Helvetica-Bold').fontSize(11.5).text(title, M, pdf.y, { width: CONTENT });
  pdf.y += 5;
  pdf.fillColor(INK).font('Helvetica').fontSize(10);
}

function body(text, opts = {}) {
  const width = opts.width ?? CONTENT;
  pdf.font(opts.font ?? 'Helvetica').fontSize(opts.size ?? 10).fillColor(opts.color ?? INK);
  const h = pdf.heightOfString(text, { width, lineGap: 2.2 });
  need(Math.min(h, 120));
  pdf.text(text, M, pdf.y, { width, lineGap: 2.2 });
  pdf.y += opts.gap ?? 7;
}

function bullets(items, opts = {}) {
  pdf.font('Helvetica').fontSize(10).fillColor(INK);
  for (const item of items) {
    const text = typeof item === 'string' ? item : item.text;
    const lead = typeof item === 'string' ? null : item.lead;
    const indent = M + 14;
    const width = CONTENT - 14;
    const h = pdf.heightOfString(lead ? `${lead}  ${text}` : text, { width, lineGap: 2.2 });
    need(h + 4);
    const y = pdf.y;
    pdf.fillColor(BRAND).font('Helvetica-Bold').fontSize(10).text('•', M + 3, y);
    pdf.y = y;
    if (lead) {
      pdf.fillColor(INK).font('Helvetica-Bold').text(lead, indent, y, { continued: true });
      pdf.font('Helvetica').text(`  ${text}`, { width, lineGap: 2.2 });
    } else {
      pdf.fillColor(INK).font('Helvetica').text(text, indent, y, { width, lineGap: 2.2 });
    }
    pdf.y += 3.5;
  }
  pdf.y += opts.gap ?? 4;
}

/** A command to type. Dark panel, monospaced, so it cannot be confused with prose. */
function code(lines, opts = {}) {
  const arr = Array.isArray(lines) ? lines : [lines];
  pdf.font('Courier').fontSize(8.6);
  const lineH = 12;
  const boxH = arr.length * lineH + 18;
  need(boxH + 8);
  const y = pdf.y;
  pdf.rect(M, y, CONTENT, boxH).fill(opts.bg ?? CODE_BG);
  arr.forEach((ln, i) => {
    pdf.fillColor(ln.startsWith('#') ? '#7dd3fc' : '#e2e8f0').font('Courier').fontSize(8.6)
      .text(ln, M + 12, y + 9 + i * lineH, { width: CONTENT - 24, lineBreak: false });
  });
  pdf.y = y + boxH + 8;
  pdf.fillColor(INK).font('Helvetica').fontSize(10);
}

function table(cols, rows, opts = {}) {
  const widths = cols.map((c) => c.width * CONTENT);
  const pad = 6;
  const headH = 20;
  const drawHead = () => {
    need(headH + 26);
    const y = pdf.y;
    pdf.rect(M, y, CONTENT, headH).fill(opts.headColor ?? BRAND);
    pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5);
    let x = M;
    cols.forEach((c, i) => {
      pdf.text(c.label.toUpperCase(), x + pad, y + 6,
        { width: widths[i] - pad * 2, align: c.align ?? 'left', characterSpacing: 0.4 });
      x += widths[i];
    });
    pdf.y = y + headH;
  };
  drawHead();
  rows.forEach((row, ri) => {
    let cellH = 0;
    row.forEach((cell, i) => {
      const txt = typeof cell === 'string' ? cell : cell.text;
      const bold = typeof cell === 'object' && cell.bold;
      pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.8);
      cellH = Math.max(cellH, pdf.heightOfString(txt, { width: widths[i] - pad * 2, lineGap: 1.5 }));
    });
    const rowH = cellH + pad * 2 - 2;
    if (pdf.y + rowH > BOTTOM) { pdf.addPage(); pdf.y = M + 14; drawHead(); }
    const y = pdf.y;
    if (ri % 2 === 1) pdf.rect(M, y, CONTENT, rowH).fill(ALT);
    let x = M;
    row.forEach((cell, i) => {
      const txt = typeof cell === 'string' ? cell : cell.text;
      const bold = typeof cell === 'object' && cell.bold;
      const color = (typeof cell === 'object' && cell.color) || INK;
      const mono = typeof cell === 'object' && cell.mono;
      pdf.fillColor(color).font(mono ? 'Courier' : bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.8);
      pdf.text(txt, x + pad, y + pad - 1,
        { width: widths[i] - pad * 2, align: cols[i].align ?? 'left', lineGap: 1.5 });
      x += widths[i];
    });
    pdf.y = y + rowH;
    pdf.moveTo(M, pdf.y).lineTo(M + CONTENT, pdf.y).lineWidth(0.5).strokeColor(RULE).stroke();
  });
  pdf.y += opts.gap ?? 10;
  pdf.fillColor(INK).font('Helvetica').fontSize(10);
}

function callout(title, text, tone = BRAND) {
  pdf.font('Helvetica').fontSize(9.4);
  const width = CONTENT - 34;
  const bodyH = pdf.heightOfString(text, { width, lineGap: 2.2 });
  pdf.font('Helvetica-Bold').fontSize(9.6);
  const titleH = title ? pdf.heightOfString(title, { width }) + 4 : 0;
  const boxH = bodyH + titleH + 28;
  need(boxH + 10);
  const y = pdf.y;
  pdf.rect(M, y, CONTENT, boxH).fill('#f8fafc');
  pdf.rect(M, y, 3.5, boxH).fill(tone);
  let ty = y + 9;
  if (title) {
    pdf.fillColor(tone).font('Helvetica-Bold').fontSize(9.6).text(title, M + 18, ty, { width });
    ty += titleH + 1;
  }
  pdf.fillColor(INK).font('Helvetica').fontSize(9.4).text(text, M + 18, ty, { width, lineGap: 2.2 });
  pdf.y = y + boxH + 10;
  pdf.fillColor(INK).font('Helvetica').fontSize(10);
}

// ---------------------------------------------------------------------------
// Cover
// ---------------------------------------------------------------------------
pdf.rect(0, 0, PAGE_W, 132).fill(BRAND);
// No mark for a company that did not supply one — their name on the cover is
// a complete cover. A missing file must not stop their guide being produced.
if (LOGO && fs.existsSync(LOGO)) pdf.image(LOGO, M, 40, { height: 52 });

pdf.fillColor(INK).font('Helvetica-Bold').fontSize(29)
  .text('Setting up on the', M, 205, { width: CONTENT });
pdf.fillColor(INK).font('Helvetica-Bold').fontSize(29)
  .text('shop PC', M, pdf.y - 4, { width: CONTENT });

pdf.y += 12;
pdf.moveTo(M, pdf.y).lineTo(M + 70, pdf.y).lineWidth(3).strokeColor(BRAND).stroke();
pdf.y += 20;

pdf.fillColor(MUTED).font('Helvetica').fontSize(13)
  .text(`${COMPANY} ${TAGLINE}`, M, pdf.y, { width: CONTENT });
pdf.y += 4;
pdf.fillColor(LIGHT).font('Helvetica').fontSize(11)
  .text('One PC runs everything. Staff phones and the counter iPad reach it\nover the shop WiFi. Follow the steps in order.',
    M, pdf.y, { width: CONTENT, lineGap: 3 });

pdf.y = 455;
pdf.moveTo(M, pdf.y).lineTo(M + CONTENT, pdf.y).lineWidth(0.75).strokeColor(RULE).stroke();
pdf.y += 18;

[
  ['Time needed', 'About one hour, most of it waiting for downloads'],
  ['Difficulty', 'You copy and paste commands — no programming'],
  ['Cost', 'Nothing. No monthly fee, no domain name'],
  ['Works on', 'Windows 10 or 11 (64-bit). Linux notes included'],
  ['Date', '3 August 2026'],
].forEach(([k, v]) => {
  const y = pdf.y;
  pdf.fillColor(LIGHT).font('Helvetica-Bold').fontSize(8.4)
    .text(k.toUpperCase(), M, y, { width: 120, characterSpacing: 0.6 });
  pdf.fillColor(INK).font('Helvetica').fontSize(10)
    .text(v, M + 130, y - 1, { width: CONTENT - 130 });
  pdf.y = Math.max(pdf.y, y) + 9;
});

pdf.y = PAGE_H - 148;
pdf.rect(M, pdf.y, CONTENT, 3).fill(BRAND);
pdf.y += 14;
pdf.fillColor(MUTED).font('Helvetica').fontSize(8.6)
  .text('Read Part 8 before you start using this for real. It explains the two things this '
    + 'setup does NOT protect you from, and what to do about each. Neither is a reason not to '
    + 'start — but both are reasons to keep the backups.',
    M, pdf.y, { width: CONTENT, lineGap: 2 });

// ---------------------------------------------------------------------------
pdf.addPage();
const tocPage = pageIndex();

pdf.addPage();
pdf.y = M + 14;

// ---------------------------------------------------------------------------
h1('1', 'Before you start');

body('One computer in the shop runs the whole system. Everyone else — staff phones, the '
  + 'counter iPad, your own laptop — opens it in a normal web browser over the shop WiFi. '
  + 'Nothing is installed on the phones.');

h2('The PC you will use');

table(
  [{ label: 'Requirement', width: 0.3 }, { label: 'Why', width: 0.7 }],
  [
    ['Windows 10 or 11, 64-bit', 'Docker Desktop needs it. A Linux PC works too — the differences are noted in each step.'],
    ['8 GB memory or more', 'The database, the server and the web app run side by side. 4 GB will struggle.'],
    ['20 GB free disk', 'Roughly 6 GB for the software, the rest is your records and backups growing over the years.'],
    ['Left switched on', 'When this PC is off, nobody can ring a sale or look anything up. Treat it like the shop phone line.'],
    ['On the shop WiFi or cable', 'Cable is better if you can — a counter PC on a dropped WiFi link takes the till down with it.'],
  ],
);

callout('Pick the right PC',
  'Use the PC that already stays on all day, not the newest one. What matters is that it is not '
  + 'switched off at 6pm, not carried home, and not the one a customer might borrow. If you have an '
  + 'old machine doing nothing, that is often the better choice than the busy counter PC.');

// ---------------------------------------------------------------------------
h1('STEP 1', 'Install Docker Desktop');

body('Docker is the program that runs the system. You install it once and then mostly forget it.');

bullets([
  'Go to docker.com and download "Docker Desktop for Windows".',
  'Run the installer, accept the defaults, and restart the PC when it asks.',
  'Open Docker Desktop once so it finishes setting itself up. You should see "Engine running" at the bottom left.',
  { lead: 'Important:', text: 'in Docker Desktop go to Settings → General and tick "Start Docker Desktop when you log in". Without this, the system will not come back after a power cut.' },
]);

body('On Linux instead: install Docker Engine and the Compose plugin from your distribution, then '
  + 'run "sudo systemctl enable --now docker".');

// ---------------------------------------------------------------------------
h1('STEP 2', 'Put the app on the PC');

body('Open PowerShell (press Start, type PowerShell, press Enter) and run these one at a time. '
  + 'The first installs Git if you do not have it; skip it if you do.');

code([
  '# Install Git (skip if already installed)',
  'winget install --id Git.Git -e',
  '',
  `# Download the app into ${DIR}`,
  'cd C:\\',
  `git clone <YOUR REPOSITORY URL> ${FOLDER}`,
  `cd ${DIR}`,
]);

callout('Where does the repository URL come from?',
  'It is the address of this project on GitHub — the same one you use to view the code. If you are '
  + 'not sure, ask whoever set up the GitHub account, or copy it from the green "Code" button on the '
  + 'repository page. If you would rather not use Git at all, download the project as a ZIP from that '
  + `same button and unzip it to ${DIR} instead.`);

// ---------------------------------------------------------------------------
h1('STEP 3', 'Create your passwords file');

body('The system needs four secrets. They are never typed by a person again, so make them long and '
  + 'random rather than memorable. This command generates all four and writes the file for you:');

code([
  `cd ${DIR}`,
  'Copy-Item .env.prod.example .env.prod',
  '',
  '# Generate four random secrets and put them in the file',
  'function New-Secret { -join ((48..57)+(65..90)+(97..122) |',
  '  Get-Random -Count 40 | ForEach-Object {[char]$_}) }',
  '',
  '(Get-Content .env.prod) `',
  "  -replace '^POSTGRES_PASSWORD=.*', \"POSTGRES_PASSWORD=$(New-Secret)\" `",
  "  -replace '^EMIL_APP_PASSWORD=.*',  \"EMIL_APP_PASSWORD=$(New-Secret)\" `",
  "  -replace '^EMIL_WORKER_PASSWORD=.*',\"EMIL_WORKER_PASSWORD=$(New-Secret)\" `",
  "  -replace '^JWT_SECRET=.*',         \"JWT_SECRET=$(New-Secret)\" |",
  '  Set-Content .env.prod',
]);

callout('Keep this file, and keep it private', 'The .env.prod file is the key to your books. '
  + 'Copy it somewhere safe that is NOT the shop PC — a password manager, or a printed copy in the '
  + 'safe. If the PC dies and you have the backups but not this file, restoring is far harder. '
  + 'Equally: never post it in a chat, an email or a photo.', WARN);

// ---------------------------------------------------------------------------
h1('STEP 4', 'Start it for the first time');

body('This builds and starts everything. The first run downloads a lot and can take 10–20 minutes; '
  + 'after that, starting takes seconds.');

code([
  `cd ${DIR}`,
  'docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build',
]);

body('When it finishes, check that everything is running:');

code(['docker compose -f docker-compose.prod.yml --env-file .env.prod ps']);

body('You want to see the "db", "api", "worker" and "web" lines all saying running or healthy. '
  + 'The "migrate" and "roles" lines will say exited — that is correct, they are one-off setup jobs '
  + 'that finish and stop.');

body('Now open a browser on the PC itself and go to:');

code(['http://localhost:8080']);

body(`You should see the ${COMPANY} sign-in page. If you do, the hard part is over.`);

// ---------------------------------------------------------------------------
h1('STEP 5', 'Create your account and set up the shop');

bullets([
  'On the sign-in page, choose "New here? Create an account".',
  'Register yourself with your name, email and a password of at least 12 characters. A short phrase you will remember beats a clever word you will not.',
  'You are taken to the setup screen. Enter the business name exactly as it is registered with SSM, and the first day of your financial year.',
  'That is it — you are the Owner, and the books exist.',
]);

callout('Do the opening balances properly, once',
  'Under Settings there is an Opening Balances screen. This is where you tell the system what the '
  + 'shop already had and owed on the day you started using it — cash in the bank, stock on the '
  + 'shelf, money customers owe you, money you owe suppliers. Until you do this, the reports are '
  + 'correct about everything that happened SINCE you started and silent about everything before. '
  + 'It is worth sitting down with your accountant for an hour to get these right.');

// ---------------------------------------------------------------------------
h1('STEP 6', 'Find the PC on the shop WiFi');

body('Phones need the PC\'s address on the local network. Run:');

code(['ipconfig']);

body('Look for "IPv4 Address" under your active network. It will look like 192.168.1.50 or '
  + '10.0.0.23. Write it down — that number is what the phones will use.');

callout('Fix the address so it never changes',
  'By default the router hands out addresses that can change when the PC restarts — and every phone '
  + 'bookmark breaks the day it does. Log into your router and set a "DHCP reservation" (sometimes '
  + 'called "static lease" or "address binding") for this PC, so it always receives the same address. '
  + 'Every home and shop router has this; it is usually under LAN or DHCP settings. Do this now, not '
  + 'after the bookmarks break.', WARN);

h2('Now tell the app its own address');

body('Every invoice, receipt, warranty card and repair report you print carries a small square QR '
  + 'code. A customer scans it and sees the document checked against your records — proof that the '
  + 'paper in their hand is genuine and has not been altered. The app has to be told what address to '
  + 'print in that code, because it cannot know it by itself.');

body(`Open ${DIR}\\.env.prod in Notepad, find the line beginning PUBLIC_BASE_URL, and put the `
  + 'address from this step after the equals sign:');

code(['PUBLIC_BASE_URL=http://192.168.1.50:8080']);

body('Save the file, then apply it:');

code([
  `cd ${DIR}`,
  'docker compose -f docker-compose.prod.yml --env-file .env.prod up -d',
]);

callout('A local address only works for people standing in your shop',
  'A phone on the shop WiFi can open 192.168.1.50. A customer who takes the warranty card home '
  + 'cannot — their phone will simply say the page is not available. That is fine if your paperwork '
  + 'stays in the shop, and not fine if it goes out of the door. The fix is Section 6 (Tailscale) or '
  + 'a proper domain name, and until then the document also prints the code as text underneath, so '
  + 'you can always look it up yourself. Get this line right BEFORE you print anything a customer '
  + 'keeps: you can change it whenever you like, but paper already handed over keeps the old address.',
  WARN);

h2('And put your own name on the sign-in page');

body('The sign-in screen everybody sees each morning shows the name of this installation. Set it in '
  + 'the same file, on the line beginning NEXT_PUBLIC_APP_NAME:');

code([`NEXT_PUBLIC_APP_NAME=${COMPANY} — ${TAGLINE}`]);

body('Whatever comes before the dash is set larger, and the rest goes underneath in smaller type. '
  + 'A single name with no dash is perfectly fine.');

body('For your logo, put a PNG file here — any square-ish image, your signboard or your mark:');

code([`${DIR}\\apps\\web\\public\\brand\\mark.png`]);

body('Two more are optional and go in the same folder: wordmark.png, your name drawn as a logo, and '
  + 'shop.jpg, a photograph of your premises used as the background. Supply neither and the page '
  + 'shows your initials on a tile over a plain dark background, which looks deliberate rather than '
  + 'unfinished.');

callout('This one needs --build on the end',
  'The name and the pictures are baked in when the app is put together, not read while it runs, so '
  + 'the usual command is not enough on its own. Use this one after changing any of them — it is the '
  + 'same command with two extra words, and it takes a few minutes rather than a few seconds:',
  BRAND);

code([
  `cd ${DIR}`,
  'docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build',
]);

// ---------------------------------------------------------------------------
h1('STEP 7', 'Let the phones through the firewall');

body('Windows blocks incoming connections by default. Open PowerShell as Administrator (right-click '
  + 'PowerShell, "Run as administrator") and run:');

code([
  `New-NetFirewallRule -DisplayName "${COMPANY} books" \``,
  '  -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow',
]);

body('On Linux with ufw instead: "sudo ufw allow 8080/tcp".');

// ---------------------------------------------------------------------------
h1('STEP 8', 'Connect the phones');

body('On each phone, connected to the shop WiFi, open the browser and go to the address you wrote '
  + 'down in Step 6, followed by :8080 — for example:');

code(['http://192.168.1.50:8080']);

h2('Put it on the home screen');

body('Do this on every phone and on the counter iPad. It is not a bookmark: the system tells the '
  + 'phone it is an app, so it gets its own icon on the home screen and opens FULL SCREEN, with no '
  + 'address bar and no browser buttons across the top. Staff will not be able to tell it apart from '
  + 'anything else on their phone, and there is one less row of pixels between a cashier and the '
  + '"Change due" figure.');

table(
  [{ label: 'Phone', width: 0.22 }, { label: 'How', width: 0.78 }],
  [
    [{ text: 'iPhone / iPad', bold: true }, 'Open the page in Safari, tap the Share button (the square with an arrow), scroll down and tap "Add to Home Screen".'],
    [{ text: 'Android', bold: true }, 'Open the page in Chrome, tap the three dots at the top right, tap "Install app" or "Add to Home screen".'],
  ],
);

body(`The icon is the picture you put at ${DIR}\\apps\\web\\public\\brand\\mark.png in Step 6. `
  + 'If you did not put one there, the phone shows a letter tile instead — still a proper icon, just '
  + 'not yours. Change the picture and rebuild, and the icon follows on every phone the next time it '
  + 'is added.');

body('The screens are built to work at phone size: the menu becomes a strip of icons down the left, '
  + 'and wide tables scroll sideways inside their own box rather than dragging the whole page about. '
  + 'The till, repairs, stock and the day\'s takings are all comfortable on a phone. The Journals and '
  + 'Reports screens are readable but cramped — those are accountant screens, better on the PC or the '
  + 'iPad.');

// ---------------------------------------------------------------------------
h1('STEP 9', 'Add your staff');

body('Each member of staff registers themselves first, then you give them access:');

bullets([
  'Ask them to open the app and choose "New here? Create an account", and to tell you the email they used.',
  'You go to Team, enter that email, and choose their role.',
  'They sign out and back in, and they are in the shop.',
]);

h2('Which role to give');

table(
  [{ label: 'Role', width: 0.22 }, { label: 'Give it to', width: 0.78 }],
  [
    [{ text: 'Owner', bold: true }, 'You, and nobody else unless you mean it. Sees and does everything, including closing the year.'],
    [{ text: 'Admin', bold: true }, 'A trusted manager. Everything except acting on an Owner.'],
    [{ text: 'Accountant', bold: true }, 'Your accountant or bookkeeper. The full books, including journals and reports.'],
    [{ text: 'Approver', bold: true }, 'Whoever signs off supplier bills above the limit.'],
    [{ text: 'Sales', bold: true }, 'Counter staff. The till, customers, invoices, stock levels.'],
    [{ text: 'Technician', bold: true }, 'Workshop staff. Repair jobs and stock — deliberately CANNOT see money: no takings, no reports, no customer debts.'],
    [{ text: 'Read only', bold: true }, 'Someone who needs to look and not touch.'],
  ],
);

callout('The technician role is the one worth understanding',
  'A technician can book a repair in, order the part, and mark it done — and cannot see what the shop '
  + 'took today, what any customer owes, or what anything cost you. That is deliberate. It means you '
  + 'can hand a phone to workshop staff without handing over the shop\'s finances.');

// ---------------------------------------------------------------------------
h1('2', 'Backups — do not skip this');

body('The system already takes a backup of everything every night and keeps the last fourteen, in '
  + `the "backups" folder inside ${DIR}. That protects you from a mistake. It does NOT protect `
  + 'you from the PC being stolen, catching fire, or its disk failing — because the backups are on '
  + 'that same disk.');

h2('Copy them off the PC — weekly at least');

body('The simplest version that actually works: plug in a USB stick every Friday and run:');

code([
  `Copy-Item ${DIR}\\backups\\*.dump E:\\shop-backups\\`,
]);

body('(Replace E: with whatever letter the USB stick gets.) Better still, install a cloud sync '
  + 'folder — Google Drive, OneDrive, Dropbox — and point it at the backups folder so it copies '
  + 'itself. Ten minutes to set up once.');

callout('Test a restore once, before you need it',
  'A backup nobody has ever restored is a hope, not a backup. Once — ideally in the first month — '
  + 'take one of the .dump files and restore it into a scratch database to prove the file is good '
  + 'and that you know how. The command is in docs/DEPLOY.md. Doing this the first time during a '
  + 'real emergency is how people discover their backups were empty for a year.', BAD);

// ---------------------------------------------------------------------------
h1('3', 'Everyday running');

table(
  [{ label: 'What you want', width: 0.3 }, { label: `What to type (in ${DIR})`, width: 0.7 }],
  [
    ['See if it is running', { text: 'docker compose -f docker-compose.prod.yml --env-file .env.prod ps', mono: true }],
    ['Start it', { text: 'docker compose -f docker-compose.prod.yml --env-file .env.prod up -d', mono: true }],
    ['Stop it', { text: 'docker compose -f docker-compose.prod.yml --env-file .env.prod stop', mono: true }],
    ['Look at the logs', { text: 'docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f api', mono: true }],
    ['Update to a new version', { text: 'git pull, then the same up -d --build as Step 4', mono: true }],
  ],
);

body('After a power cut or a Windows restart, the system starts itself — provided you ticked "Start '
  + 'Docker Desktop when you log in" in Step 1, and provided somebody logs into Windows on that PC. '
  + 'It is worth setting Windows to log in automatically on that machine so a reboot at 3am does not '
  + 'leave the shop without a till at 9am.');

// ---------------------------------------------------------------------------
h1('4', 'When something goes wrong');

table(
  [{ label: 'What you see', width: 0.32 }, { label: 'Almost always', width: 0.68 }],
  [
    ['Phones cannot reach it, PC can', 'The firewall rule (Step 7), or the phone is on mobile data / guest WiFi rather than the shop WiFi.'],
    ['It worked yesterday, not today', 'The PC\'s address changed. Run ipconfig again — and then set the DHCP reservation in Step 6 so it stops happening.'],
    ['"Bad gateway" or a blank page', 'The system is still starting. Wait a minute, then check ps. If "api" is not healthy, look at its logs.'],
    ['Everything is very slow', 'The PC is short of memory. Close other programs; check Docker Desktop → Settings → Resources.'],
    ['Docker says "port is already allocated"', 'Something else on the PC uses port 8080. Change WEB_PORT in .env.prod to 8090 and start again — the phone addresses then end :8090.'],
    ['You forgot the Owner password', 'There is no password reset yet. This is why a second Owner or Admin account is worth creating on day one.'],
  ],
);

// ---------------------------------------------------------------------------
h1('5', 'Two things this setup does not protect you from');

body('Both are worth knowing before you rely on this. Neither is a reason to wait.');

h2('The connection is not encrypted');

body('Inside the shop the app is served over plain http, not https, because a certificate cannot be '
  + 'issued for a bare local address like 192.168.1.50. In practice that means passwords and figures '
  + 'travel across your WiFi unencrypted. On a private shop WiFi with a WPA2 or WPA3 password this is '
  + 'a modest risk — but it is a real one, so:');

bullets([
  'Make sure the shop WiFi has a proper password and is not open.',
  'Do not use the system over a public or guest network.',
  'Do not give the WiFi password to customers who are not on a separate guest network.',
]);

body('Adding Tailscale (Part 6) fixes this properly: it encrypts the connection end to end, even '
  + 'inside the shop.');

h2('Everything lives on one PC');

body('If that PC dies, the books die with it — unless the backups are somewhere else. This is the '
  + 'whole reason Part 2 exists, and it is the single most important thing in this guide. A cloud '
  + 'server removes this weakness entirely, and is worth revisiting once the shop is used to the '
  + 'system.');

// ---------------------------------------------------------------------------
h1('6', 'Later: seeing it from home');

body('When you want the boss — or yourself — to open the books from home, from a supplier\'s office '
  + 'or from anywhere else, add Tailscale. It builds a private encrypted network between your devices '
  + 'and the shop PC. It is free for a shop this size, and it needs no domain name, no router '
  + 'configuration and no fixed internet address.');

bullets([
  'Create a free account at tailscale.com.',
  'Install Tailscale on the shop PC and sign in. It gets a permanent private address, something like 100.101.102.103.',
  'Install the Tailscale app on each phone or laptop that needs access from outside, and sign in with the same account.',
  'From anywhere, those devices open http://100.101.102.103:8080 and see the shop.',
]);

body('Inside the shop nothing changes — phones keep using the local address, which is faster. Two '
  + 'things worth knowing: the shop PC must still be switched on and have working internet, because '
  + 'it is still the only machine holding your books; and everyone using it from outside needs the '
  + 'Tailscale app installed and signed in.');

body('If you set PUBLIC_BASE_URL in Step 6, consider changing it to the Tailscale address now — that '
  + 'one reaches the shop from outside the building, so the QR code on a document works for anyone '
  + 'you have added to your Tailscale network. It still will not work for an ordinary customer, who '
  + 'has no Tailscale account; only a real domain name does that. Apply the change the same way: edit '
  + '.env.prod, then run the up -d command again.');

callout('When to consider moving off the shop PC entirely',
  'If you reach the point where the shop cannot work for an afternoon because the PC is down, or you '
  + 'find yourself worrying about the building, that is the signal to move to a rented cloud server — '
  + 'roughly RM 40–80 a month, always on, backed up off-site, reachable from anywhere without any app '
  + 'to install. Everything you set up here transfers: the same commands, the same files. Nothing in '
  + 'this guide is wasted work.');

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------
pdf.switchToPage(tocPage);
pdf.y = M + 14;
pdf.fillColor(INK).font('Helvetica-Bold').fontSize(19).text('What is in here', M, pdf.y);
pdf.y += 8;
pdf.moveTo(M, pdf.y).lineTo(M + 46, pdf.y).lineWidth(2.5).strokeColor(BRAND).stroke();
pdf.y += 20;

pdf.fillColor(MUTED).font('Helvetica').fontSize(9.5)
  .text('Steps 1 to 9 are the setup, in order. Parts 2 to 6 are what happens afterwards — read Part 5 '
    + 'before you rely on the system for real.', M, pdf.y, { width: CONTENT, lineGap: 2.5 });
pdf.y += 18;

toc.forEach((entry) => {
  const y = pdf.y;
  const isStep = entry.number.startsWith('STEP');
  pdf.fillColor(isStep ? BRAND : BRAND_DARK).font('Helvetica-Bold').fontSize(9)
    .text(isStep ? entry.number.replace('STEP ', 'Step ') : `Part ${entry.number}`, M, y + 1.5, { width: 54 });
  pdf.fillColor(INK).font('Helvetica-Bold').fontSize(10.5)
    .text(entry.title, M + 58, y, { width: CONTENT - 92 });
  pdf.fillColor(LIGHT).font('Helvetica').fontSize(9.5)
    .text(String(entry.page + 1), M + CONTENT - 30, y + 1, { width: 30, align: 'right' });
  pdf.y = y + 19;
});

// ---------------------------------------------------------------------------
// Header / footer
// ---------------------------------------------------------------------------
const range = pdf.bufferedPageRange();
for (let i = range.start; i < range.start + range.count; i++) {
  if (i === 0) continue;
  pdf.switchToPage(i);
  pdf.page.margins.bottom = 0;
  pdf.rect(0, 0, PAGE_W, 3).fill(BRAND);
  pdf.fillColor(LIGHT).font('Helvetica').fontSize(7.6)
    .text(`${COMPANY} ${TAGLINE} — SETUP GUIDE`.toUpperCase(), M, 22,
      { width: CONTENT, characterSpacing: 0.5 });
  pdf.moveTo(M, PAGE_H - 44).lineTo(M + CONTENT, PAGE_H - 44)
    .lineWidth(0.5).strokeColor(RULE).stroke();
  pdf.fillColor(LIGHT).font('Helvetica').fontSize(7.6)
    .text('Keep this with the shop records', M, PAGE_H - 36, { width: CONTENT / 2 });
  pdf.fillColor(MUTED).font('Helvetica-Bold').fontSize(8.4)
    .text(String(i + 1), M + CONTENT / 2, PAGE_H - 36, { width: CONTENT / 2, align: 'right' });
}

pdf.end();
process.stdout.write(`Setup guide written to ${OUT}\n`);
