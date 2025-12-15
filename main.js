const state = { localPlayersJson: null, loadedDatabases: [], attributeMapping: {}, allAttributes: new Set(), importedPlayers: new Map(), stats: { imported: 0, added: 0, duplicates: 0 } };
const CORS = ['https://api.allorigins.win/raw?url=', 'https://corsproxy.io/?url='];

async function fetchUrl(url) {
    try { let r = await fetch(url); if (r.ok) return await r.json(); } catch { }
    for (const p of CORS) { try { let r = await fetch(p + encodeURIComponent(url)); if (r.ok) return await r.json(); } catch { } }
    throw 'fail';
}

const parseId = s => {
    if (!s) return null;
    const m = s.match(/\[U:1:(\d+)\]/);
    if (m) return m[1];
    if (/^7656\d{13}$/.test(s)) {
        try { return (BigInt(s) - 76561197960265728n).toString(); } catch { }
    }
    return null;
};

async function loadUrl(url) {
    const d = await fetchUrl(url);
    if (!d.players) throw 'bad';
    const name = d.file_info?.title || url.split('/').pop().replace('.json', '');
    return { name, src: 'url', players: d.players.filter(p => p.steamid).map(p => ({ id: parseId(p.steamid), attrs: p.attributes || [] })).filter(p => p.id) };
}

function loadFile(f, d) {
    return { name: f.name.replace('.json', ''), src: 'file', players: d.players.filter(p => p.steamid).map(p => ({ id: parseId(p.steamid), attrs: p.attributes || [] })).filter(p => p.id) };
}

function process() {
    state.allAttributes.clear(); state.importedPlayers.clear();
    state.stats = { imported: 0, added: 0, duplicates: 0 };
    const ex = new Set();
    if (state.localPlayersJson?.Tags) Object.keys(state.localPlayersJson.Tags).forEach(i => ex.add(i));
    for (const db of state.loadedDatabases) for (const p of db.players) {
        state.stats.imported++;
        p.attrs.forEach(a => state.allAttributes.add(a));
        if (ex.has(p.id) || state.importedPlayers.has(p.id)) state.stats.duplicates++;
        else { state.importedPlayers.set(p.id, new Set(p.attrs)); ex.add(p.id); state.stats.added++; }
    }
}

function getTags() {
    if (!state.localPlayersJson?.Config) return null;
    const t = {}; Object.entries(state.localPlayersJson.Config).forEach(([k, v]) => t[k] = v.Name || k); return t;
}

function build() {
    const o = JSON.parse(JSON.stringify(state.localPlayersJson || { Config: {}, Tags: {} }));
    for (const [id, attrs] of state.importedPlayers) { const m = [...attrs].map(a => state.attributeMapping[a]).filter(Boolean); if (m.length) o.Tags[id] = m; }
    return o;
}

function renderDb() {
    const c = document.getElementById('loaded-databases'); if (!c) return;
    c.innerHTML = state.loadedDatabases.map((d, i) => `<div class="db"><span class="n">${d.name}</span> · ${d.players.length}<button class="x" data-i="${i}">×</button></div>`).join('');
}

function renderMap() {
    const c = document.getElementById('mapping-container'); if (!c) return;
    const t = getTags();
    if (!t) { c.innerHTML = '<span class="dim">load players.json first</span>'; return; }
    if (!state.allAttributes.size) { c.innerHTML = '<span class="dim">import databases</span>'; return; }
    const cnt = {}; state.allAttributes.forEach(a => cnt[a] = 0);
    state.importedPlayers.forEach(at => at.forEach(a => cnt[a]++));
    c.innerHTML = '';
    state.allAttributes.forEach(a => {
        const r = document.createElement('div'); r.className = 'mr';
        const s = document.createElement('select');
        s.innerHTML = '<option value="">skip</option>' + Object.entries(t).map(([k, v]) => `<option value="${k}"${state.attributeMapping[a] === k ? ' selected' : ''}>${k}: ${v}</option>`).join('');
        s.onchange = e => state.attributeMapping[a] = e.target.value;
        r.innerHTML = `<span class="n">${a}</span><span class="c">(${cnt[a]})</span>`;
        r.appendChild(s); c.appendChild(r);
    });
}

function renderStats() {
    document.getElementById('stat-imported').textContent = state.stats.imported;
    document.getElementById('stat-added').textContent = state.stats.added;
    document.getElementById('stat-duplicates').textContent = state.stats.duplicates;
}

const refresh = () => { process(); renderDb(); renderMap(); renderStats(); };

function clearLocal() { state.localPlayersJson = null; document.getElementById('local-status').innerHTML = ''; document.getElementById('local-file-input').value = ''; refresh(); }

function download() {
    const json = JSON.stringify(build(), null, 4);
    const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = 'Players.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

document.addEventListener('DOMContentLoaded', () => {
    const $ = id => document.getElementById(id);
    const mU = $('mode-url'), mF = $('mode-file'), uM = $('url-mode'), fM = $('file-mode');

    mU?.addEventListener('click', () => { mU.classList.add('active'); mF.classList.remove('active'); uM.classList.remove('hide'); fM.classList.add('hide'); });
    mF?.addEventListener('click', () => { mF.classList.add('active'); mU.classList.remove('active'); fM.classList.remove('hide'); uM.classList.add('hide'); });

    $('add-url-btn')?.addEventListener('click', async () => {
        const u = $('url-input').value.trim(); if (!u) return;
        if (state.loadedDatabases.some(db => db.url === u)) { alert('already loaded'); return; }
        try { const db = await loadUrl(u); db.url = u; state.loadedDatabases.push(db); refresh(); $('url-input').value = ''; } catch { alert('fail'); }
    });

    document.querySelectorAll('[data-url]').forEach(b => b.addEventListener('click', async () => {
        const u = b.dataset.url;
        if (state.loadedDatabases.some(db => db.url === u)) { alert('already loaded'); return; }
        b.disabled = true; try { const db = await loadUrl(u); db.url = u; state.loadedDatabases.push(db); refresh(); } catch { alert('fail'); } b.disabled = false;
    }));

    $('loaded-databases')?.addEventListener('click', e => { if (e.target.classList.contains('x')) { state.loadedDatabases.splice(+e.target.dataset.i, 1); refresh(); } });

    $('local-file-input')?.addEventListener('change', async e => {
        const f = e.target.files[0]; if (!f) return;
        try {
            state.localPlayersJson = JSON.parse(await f.text());
            const n = Object.keys(state.localPlayersJson.Tags || {}).length;
            $('local-status').innerHTML = `<span class="fr">${f.name} (${n})<button class="x" id="cl">×</button></span>`;
            $('cl').onclick = clearLocal; refresh();
        } catch { alert('err'); }
    });

    $('ready-file-input')?.addEventListener('change', async e => {
        const f = e.target.files[0]; if (!f) return;
        try { const d = JSON.parse(await f.text()); if (d.players) state.loadedDatabases.push(loadFile(f, d)); refresh(); e.target.value = ''; } catch { alert('err'); }
    });

    $('convert-btn')?.addEventListener('click', download);
});
