const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// --- DATABASE SETUP (RAILWAY READY) ---
const dbPath = process.env.DATABASE_PATH || './escrow.db';
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("Database connection error:", err.message);
    else console.log(`Connected to the permanent SQLite database at: ${dbPath}`);
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        email TEXT,
        isEmailVisible INTEGER,
        asset TEXT,
        assetDetails TEXT,
        estimatedTime TEXT,
        additionalInfo TEXT,
        status INTEGER,
        lastUpdated TEXT,
        timerDeadline TEXT,
        timerState TEXT,
        alertState TEXT
    )`);

    db.run(`ALTER TABLE transactions ADD COLUMN timerDeadline TEXT`, () => {});
    db.run(`ALTER TABLE transactions ADD COLUMN timerState TEXT DEFAULT 'off'`, () => {});
    db.run(`ALTER TABLE transactions ADD COLUMN alertState TEXT DEFAULT 'none'`, () => {});

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        firstName TEXT,
        lastName TEXT,
        email TEXT,
        phone TEXT,
        transactionType TEXT,
        message TEXT,
        isRead INTEGER DEFAULT 0,
        timestamp TEXT
    )`);
});

// --- CORE & LEGAL ROUTES ---
app.get('/', (req, res) => res.render('index'));
app.get('/contact', (req, res) => res.render('contact', { success: req.query.success === 'true' }));
app.get('/terms', (req, res) => res.render('terms'));
app.get('/privacy', (req, res) => res.render('privacy'));
app.get('/aml', (req, res) => res.render('aml'));
app.get('/disputes', (req, res) => res.render('disputes'));
app.get('/news-eu', (req, res) => res.render('news-eu'));
app.get('/news-fraud', (req, res) => res.render('news-fraud'));

// --- ANTI-FRAUD VERIFICATION PORTAL ---
app.get('/verify', (req, res) => {
    res.render('verify', { result: null, query: '' });
});

app.post('/verify', (req, res) => {
    const query = req.body.verifyInput.trim().toLowerCase();
    let result = null;

    // === YOUR OFFICIAL APPROVED IDs GO HERE ===
    const validAgentIDs = [
        'agt-9901', 
        'agt-4452', 
        'swx-admin-01'
    ];

    if (query === '') {
        result = { status: 'error', message: 'Please enter an email address or Agent ID.' };
    } 
    else if (query.includes('@')) {
        if (query.endsWith('@escrow-swiss.com')) {
            result = { status: 'verified', title: 'Verified Official Channel', message: `✅ The email address "${query}" is a confirmed, official EscrowSwiss communication channel.` };
        } else {
            result = { status: 'fraud', title: 'Fraud Warning', message: `❌ WARNING: The address "${query}" DOES NOT belong to EscrowSwiss. Do not send funds, documents, or personal information to this address.` };
        }
    } 
    else if (validAgentIDs.includes(query)) {
        result = { status: 'verified', title: 'Verified Agent ID', message: `✅ "${query.toUpperCase()}" is a registered and active EscrowSwiss Agent.` };
    } 
    else {
        result = { status: 'fraud', title: 'Unrecognized ID', message: `❌ WARNING: "${query.toUpperCase()}" is not a recognized Agent ID. Please cease communication and contact compliance.` };
    }

    res.render('verify', { result: result, query: req.body.verifyInput.trim() });
});

// --- CLIENT FORM SUBMISSION ---
app.post('/submit-form', (req, res) => {
    const { firstName, lastName, email, phone, transactionType, message } = req.body;
    const timestamp = new Date().toLocaleString();
    const sql = `INSERT INTO messages (firstName, lastName, email, phone, transactionType, message, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    db.run(sql, [firstName, lastName, email, phone, transactionType, message, timestamp], () => res.redirect('/contact?success=true'));
});

// --- TRACKING ROUTES ---
app.get('/track', (req, res) => res.render('track', { error: null }));
app.post('/track-search', (req, res) => res.redirect(`/track/${req.body.trackingId.trim().toUpperCase()}`));

app.get('/track/:id', (req, res) => {
    const id = req.params.id.toUpperCase();
    db.get("SELECT * FROM transactions WHERE id = ?", [id], (err, transaction) => {
        if (transaction) {
            if (transaction.timerState === 'running' && transaction.timerDeadline) {
                const deadlineTime = new Date(transaction.timerDeadline).getTime();
                if (Date.now() > deadlineTime) {
                    transaction.alertState = 'attention';
                    transaction.timerState = 'expired';
                    db.run("UPDATE transactions SET alertState = 'attention', timerState = 'expired' WHERE id = ?", [id]);
                }
            }
            res.render('tracker-result', { id: id, transaction: transaction });
        } else {
            res.render('track', { error: "Transaction ID not found." });
        }
    });
});

// --- NATIVE BROWSER SECURITY ---
function requireAdmin(req, res, next) {
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

    if (login === 'admin' && password === 'admin123') {
        db.get("SELECT COUNT(*) AS count FROM messages WHERE isRead = 0", [], (err, row) => {
            res.locals.unreadCount = row ? row.count : 0;
            return next(); 
        });
    } else {
        res.set('WWW-Authenticate', 'Basic realm="Secure Admin Area"');
        res.status(401).send('Authentication required. Refresh the page to try again.');
    }
}

// --- SECURE ADMIN DASHBOARD ---
app.get('/admin', requireAdmin, (req, res) => {
    db.all("SELECT * FROM transactions", [], (err, rows) => {
        let dbObject = {};
        rows.forEach(row => dbObject[row.id] = row);
        res.render('admin', { database: dbObject });
    });
});

app.get('/admin/add', requireAdmin, (req, res) => {
    res.render('admin-edit', { id: '', tx: null, isNew: true });
});

app.post('/admin/add', requireAdmin, (req, res) => {
    const { trackId, email, isEmailVisible, assetName, assetDetails, estimatedTime, additionalInfo, status, timerDeadline, timerState, alertState } = req.body;
    const id = trackId.trim().toUpperCase();
    const isVisible = isEmailVisible === 'on' ? 1 : 0;
    const safeStatus = parseInt(status, 10) || 1;
    const lastUpdated = new Date().toLocaleString();

    const sql = `INSERT INTO transactions (id, email, isEmailVisible, asset, assetDetails, estimatedTime, additionalInfo, status, lastUpdated, timerDeadline, timerState, alertState) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    db.run(sql, [id, email, isVisible, assetName, assetDetails, estimatedTime, additionalInfo, safeStatus, lastUpdated, timerDeadline, timerState, alertState || 'none'], () => { res.redirect('/admin'); });
});

app.get('/admin/edit/:id', requireAdmin, (req, res) => {
    const id = req.params.id.toUpperCase();
    db.get("SELECT * FROM transactions WHERE id = ?", [id], (err, tx) => {
        if (tx) res.render('admin-edit', { id: id, tx: tx, isNew: false });
        else res.redirect('/admin');
    });
});

app.post('/admin/edit/:id', requireAdmin, (req, res) => {
    const { email, isEmailVisible, assetName, assetDetails, estimatedTime, additionalInfo, status, timerDeadline, timerState, alertState } = req.body;
    
    const txId = req.params.id.toUpperCase().trim();
    const isVisible = isEmailVisible === 'on' ? 1 : 0;
    const safeStatus = parseInt(status, 10) || 1;
    const safeAlert = alertState || 'none';
    const safeTimerState = timerState || 'off';
    const lastUpdated = new Date().toLocaleString();

    const sql = `UPDATE transactions SET email = ?, isEmailVisible = ?, asset = ?, assetDetails = ?, estimatedTime = ?, additionalInfo = ?, status = ?, lastUpdated = ?, timerDeadline = ?, timerState = ?, alertState = ? WHERE id = ?`;
    
    db.run(sql, [email, isVisible, assetName, assetDetails, estimatedTime, additionalInfo, safeStatus, lastUpdated, timerDeadline, safeTimerState, safeAlert, txId], (err) => { 
        if(err) console.error("Database Update Error:", err);
        res.redirect('/admin'); 
    });
});

app.post('/admin/delete/:id', requireAdmin, (req, res) => {
    const txId = req.params.id.toUpperCase();
    db.run("DELETE FROM transactions WHERE id = ?", [txId], () => { res.redirect('/admin'); });
});

app.get('/admin/messages', requireAdmin, (req, res) => {
    db.all("SELECT * FROM messages ORDER BY id DESC", [], (err, rows) => res.render('admin-messages', { messages: rows }));
});

app.get('/admin/messages/:id', requireAdmin, (req, res) => {
    db.run("UPDATE messages SET isRead = 1 WHERE id = ?", [req.params.id], () => {
        db.get("SELECT * FROM messages WHERE id = ?", [req.params.id], (err, msg) => {
            if (msg) {
                res.locals.unreadCount = Math.max(0, res.locals.unreadCount - 1); 
                res.render('admin-message-view', { msg: msg });
            } else res.redirect('/admin/messages');
        });
    });
});

app.post('/admin/messages/delete/:id', requireAdmin, (req, res) => {
    db.run("DELETE FROM messages WHERE id = ?", [req.params.id], () => res.redirect('/admin/messages'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running securely on port ${PORT}`));