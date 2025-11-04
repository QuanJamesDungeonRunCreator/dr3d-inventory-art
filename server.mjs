// server.mjs
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import axios from 'axios';

const app = express();
app.use(helmet());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(morgan('tiny'));

const PORT = process.env.PORT || 8080;
const APPID = Number(process.env.APPID);
const PUBLISHER_KEY = process.env.PUBLISHER_KEY;

// ---- helper: parse DROP_KEYS with ranges and mixed separators ----
// Accepts: "10001,10002;10003-10010,10050"
function parseDropKeys(s) {
    const out = new Set();
    for (const chunk of String(s || '').split(/[;,]/)) {
        const t = chunk.trim();
        if (!t) continue;

        // Range "a-b"
        const m = t.match(/^(\d+)\s*-\s*(\d+)$/);
        if (m) {
            const a = Number(m[1]), b = Number(m[2]);
            if (Number.isFinite(a) && Number.isFinite(b) && a <= b) {
                for (let x = a; x <= b; x++) out.add(x);
            }
            continue;
        }

        // Single number
        const n = Number(t);
        if (Number.isFinite(n)) out.add(n);
    }
    return Array.from(out).sort((x, y) => x - y);
}

const DROP_KEYS = parseDropKeys(process.env.DROP_KEYS);

// -------------------- limiter: DISABLED by default --------------------
const ENABLE_LIMITER = String(process.env.ENABLE_LIMITER || 'false').toLowerCase() === 'true';
// no-op limiter (always resolves)
const limiter = {
    consume: async () => { /* disabled */ }
};
// ----------------------------------------------------------------------

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ---- Steam calls -----------------------------------------------------------

async function verifyTicket({ appid, ticket, steamid }) {
    // ISteamUserAuth / AuthenticateUserTicket (GET)
    const url = 'https://partner.steam-api.com/ISteamUserAuth/AuthenticateUserTicket/v1/';
    const params = { key: PUBLISHER_KEY, appid, ticket };
    const { data } = await axios.get(url, { params, timeout: 15000 });

    const ok = data?.response?.params?.result === 'OK';
    const authedSteamId = data?.response?.params?.steamid;

    return ok && (!steamid || steamid === authedSteamId)
        ? { ok: true, steamid: authedSteamId }
        : { ok: false, reason: ok ? 'steamid_mismatch' : 'auth_failed', raw: data };
}

async function grantItem({ appid, steamid, itemdefid, quantity = 1 }) {
    // Inventory grants live under IInventoryService
    const url = 'https://partner.steam-api.com/IInventoryService/AddItem/v1/';
    const form = new URLSearchParams();
    form.append('key', PUBLISHER_KEY);
    form.append('appid', String(appid));
    form.append('steamid', String(steamid));
    form.append('itemdefid[0]', String(itemdefid));
    form.append('quantity[0]', String(quantity));
    // form.append('notify', '0'); // optional

    const { data } = await axios.post(url, form, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
    });

    const resp = data?.response || {};
    let ok = resp.result === 1 || resp.success === true;

    let items = [];
    if (typeof resp.item_json === 'string') {
        try { items = JSON.parse(resp.item_json); } catch { /* ignore */ }
        if (items.length > 0) ok = true;
    }

    return { ok, items, raw: data };
}

// ---- Routes ---------------------------------------------------------------

app.get('/health', (_req, res) => {
    res.json({
        ok: true,
        appid: APPID,
        drop_keys: DROP_KEYS,
        has_key: Boolean(PUBLISHER_KEY),
        key_prefix: PUBLISHER_KEY ? PUBLISHER_KEY.slice(0, 6) + '…' : null,
        limiter_enabled: ENABLE_LIMITER
    });
});

// Verify only (no grant)
app.post('/verify-only', async (req, res) => {
    try {
        const { appid = APPID, steamid, ticket } = req.body;
        if (!appid || !steamid || !ticket) return res.status(400).json({ error: 'missing_fields' });

        const v = await verifyTicket({ appid: Number(appid), ticket, steamid });
        if (!v.ok) return res.status(401).json({ ok: false, reason: v.reason, raw: v.raw });
        return res.json({ ok: true, steamid: v.steamid });
    } catch (e) {
        console.error('verify-only error', e?.response?.status, e?.response?.data || e?.message);
        return res.status(500).json({ error: 'server_error', details: e?.response?.status || e?.message });
    }
});

// Grant only (bypasses verify) — for debugging itemdefs/permissions
app.post('/grant-only', async (req, res) => {
    try {
        const { steamid, itemdefid } = req.body;
        if (!steamid || !itemdefid) return res.status(400).json({ error: 'missing_fields' });
        if (!PUBLISHER_KEY) return res.status(500).json({ error: 'missing_publisher_key' });

        const g = await grantItem({ appid: APPID, steamid, itemdefid: Number(itemdefid), quantity: 1 });
        if (!g.ok) return res.status(502).json({ ok: false, reason: 'grant_failed', raw: g.raw });

        return res.json({ ok: true, granted: g.items, raw: g.raw });
    } catch (e) {
        console.error('grant-only error', e?.response?.status, e?.response?.data || e?.message);
        return res.status(500).json({ error: 'server_error', details: e?.response?.status || e?.message });
    }
});

// Game flow: verify + random key grant
app.post('/open-chest', async (req, res) => {
    try {
        const { appid, steamid, ticket } = req.body;
        if (!appid || !steamid || !ticket) return res.status(400).json({ error: 'missing_fields' });
        if (!PUBLISHER_KEY) return res.status(500).json({ error: 'missing_publisher_key' });
        if (!DROP_KEYS.length) return res.status(500).json({ error: 'server_not_configured' });

        // limiter is NO-OP (disabled)
        await limiter.consume(steamid);

        const v = await verifyTicket({ appid: Number(appid), ticket, steamid });
        if (!v.ok) return res.status(401).json({ error: v.reason || 'auth_failed', raw: v.raw });

        const keyDefId = pickRandom(DROP_KEYS);
        const g = await grantItem({ appid: APPID, steamid, itemdefid: keyDefId, quantity: 1 });
        if (!g.ok) return res.status(502).json({ error: 'grant_failed', raw: g.raw });

        return res.json({ ok: true, itemdefid: keyDefId, grant: g.raw });
    } catch (e) {
        console.error('open-chest error', e?.response?.status || e?.message, e?.response?.data || '');
        return res.status(500).json({
            error: 'server_error',
            details: e?.response?.status || e?.message || String(e),
        });
    }
});

// Fallback 404
app.use((_req, res) => res.status(404).send('Not Found'));

app.listen(PORT, () => {
    console.log(`server listening on :${PORT}`);
    console.log(`APPID=${APPID}`);
    console.log(`DROP_KEYS=[${DROP_KEYS.join(', ')}]`);
    console.log(`PUBLISHER_KEY set: ${!!PUBLISHER_KEY}`);
    console.log(`Limiter enabled: ${ENABLE_LIMITER} (currently disabled by default)`);
});
