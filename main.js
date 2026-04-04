const state = {
    localPlayersJson: null,
    loadedDatabases: [],
    attributeMapping: {},
    allAttributes: new Set(),
    importedPlayers: new Map(),
    importedDirectTags: new Map(),
    importedAliases: {},
    aliasConflicts: [],
    aliasResolutions: {},
    aliasListExpanded: false,
    stats: {
        imported: 0,
        added: 0,
        duplicates: 0,
        aliasesImported: 0,
        aliasesAdded: 0,
        aliasesDuplicates: 0,
        aliasesConflicts: 0
    }
};

const CORS = ['https://api.allorigins.win/raw?url=', 'https://corsproxy.io/?url='];

async function fetchUrl(url) {
    try {
        const r = await fetch(url);
        if (r.ok) return await r.json();
    } catch { }

    for (const p of CORS) {
        try {
            const r = await fetch(p + encodeURIComponent(url));
            if (r.ok) return await r.json();
        } catch { }
    }

    throw 'fail';
}

const parseId = s => {
    if (!s) return null;
    const str = String(s);
    const m = str.match(/\[U:1:(\d+)\]/);
    if (m) return m[1];
    if (/^7656\d{13}$/.test(str)) {
        try {
            return (BigInt(str) - 76561197960265728n).toString();
        } catch { }
    }
    if (/^\d+$/.test(str)) return str;
    return null;
};

function normalizeAliases(rawAliases) {
    const out = {};
    if (!rawAliases || typeof rawAliases !== 'object') return out;

    for (const [rawId, value] of Object.entries(rawAliases)) {
        const id = parseId(rawId);
        if (!id) continue;
        if (typeof value !== 'string') continue;
        const alias = value.trim();
        if (!alias) continue;
        if (!(id in out)) out[id] = alias;
    }

    return out;
}

function normalizeTags(rawTags) {
    const out = {};
    if (!rawTags || typeof rawTags !== 'object') return out;

    for (const [rawId, rawTagList] of Object.entries(rawTags)) {
        const id = parseId(rawId);
        if (!id) continue;
        if (!Array.isArray(rawTagList)) continue;
        const tags = rawTagList.map(v => String(v)).filter(Boolean);
        if (tags.length) out[id] = tags;
    }

    return out;
}

function normalizePlayerAttributes(playersRaw) {
    if (!Array.isArray(playersRaw)) return [];
    return playersRaw
        .filter(p => p?.steamid)
        .map(p => ({
            id: parseId(p.steamid),
            attrs: Array.isArray(p.attributes) ? p.attributes : []
        }))
        .filter(p => p.id);
}

function createTagNameToIdMap(configRaw) {
    const map = {};
    if (!configRaw || typeof configRaw !== 'object') return map;

    for (const [tagId, cfg] of Object.entries(configRaw)) {
        const name = cfg?.Name;
        if (typeof name !== 'string' || !name.trim()) continue;
        map[name.trim().toLowerCase()] = tagId;
    }

    return map;
}

function convertTagsToAttributes(tagsObject, configRaw) {
    const players = [];
    const tagNameToId = createTagNameToIdMap(configRaw);

    for (const [id, tagListRaw] of Object.entries(tagsObject || {})) {
        if (!Array.isArray(tagListRaw)) continue;
        const attrs = [];

        for (const tagVal of tagListRaw) {
            const asString = String(tagVal);
            const byIdName = configRaw?.[asString]?.Name;
            if (typeof byIdName === 'string' && byIdName.trim()) {
                attrs.push(byIdName.trim().toLowerCase());
                continue;
            }

            const byNameId = tagNameToId[asString.trim().toLowerCase()];
            if (byNameId) {
                const mappedName = configRaw?.[byNameId]?.Name;
                if (typeof mappedName === 'string' && mappedName.trim()) {
                    attrs.push(mappedName.trim().toLowerCase());
                    continue;
                }
            }

            attrs.push(asString.trim().toLowerCase());
        }

        const uniqAttrs = [...new Set(attrs.filter(Boolean))];
        if (!uniqAttrs.length) continue;
        players.push({ id: parseId(id), attrs: uniqAttrs });
    }

    return players.filter(p => p.id);
}

function normalizeDatabasePayload(data, name, src) {
    const playersFromList = normalizePlayerAttributes(data.players);
    const tags = normalizeTags(data.Tags);
    const aliases = normalizeAliases(data.Aliases);

    let playersFromTags = [];
    if (!playersFromList.length && Object.keys(tags).length) {
        playersFromTags = convertTagsToAttributes(tags, data.Config || {});
    }

    const players = [...playersFromList, ...playersFromTags];

    if (!players.length && !Object.keys(tags).length && !Object.keys(aliases).length) throw 'bad';

    return { name, src, players, tags, aliases };
}

async function loadUrl(url) {
    const d = await fetchUrl(url);
    const name = d.file_info?.title || url.split('/').pop().replace('.json', '');
    return normalizeDatabasePayload(d, name, 'url');
}

function loadFile(f, d) {
    const name = f.name.replace('.json', '');
    const db = normalizeDatabasePayload(d, name, 'file');
    db.name = `${name} (${f.name})`;
    return db;
}

function process() {
    state.allAttributes.clear();
    state.importedPlayers.clear();
    state.importedDirectTags.clear();
    state.importedAliases = {};
    state.aliasConflicts = [];
    state.stats = {
        imported: 0,
        added: 0,
        duplicates: 0,
        aliasesImported: 0,
        aliasesAdded: 0,
        aliasesDuplicates: 0,
        aliasesConflicts: 0
    };

    const existingTagIds = new Set();
    if (state.localPlayersJson?.Tags) Object.keys(state.localPlayersJson.Tags).forEach(i => existingTagIds.add(i));

    const validConfigTags = new Set();
    if (state.localPlayersJson?.Config) Object.keys(state.localPlayersJson.Config).forEach(k => validConfigTags.add(k));

    for (const db of state.loadedDatabases) {
        for (const p of db.players) {
            state.stats.imported++;
            p.attrs.forEach(a => state.allAttributes.add(a));
            if (existingTagIds.has(p.id) || state.importedPlayers.has(p.id) || state.importedDirectTags.has(p.id)) {
                state.stats.duplicates++;
                continue;
            }
            state.importedPlayers.set(p.id, new Set(p.attrs));
            existingTagIds.add(p.id);
            state.stats.added++;
        }

        for (const [id, tags] of Object.entries(db.tags || {})) {
            state.stats.imported++;
            if (existingTagIds.has(id) || state.importedPlayers.has(id) || state.importedDirectTags.has(id)) {
                state.stats.duplicates++;
                continue;
            }
            const filtered = validConfigTags.size
                ? tags.filter(t => validConfigTags.has(t))
                : tags;
            if (!filtered.length) continue;
            state.importedDirectTags.set(id, new Set(filtered));
            existingTagIds.add(id);
            state.stats.added++;
        }
    }

    const localAliases = normalizeAliases(state.localPlayersJson?.Aliases || {});
    const incomingAliases = {};

    for (const db of state.loadedDatabases) {
        for (const [id, alias] of Object.entries(db.aliases || {})) {
            if (!(id in incomingAliases)) incomingAliases[id] = alias;
        }
    }

    const nextResolutions = {};

    for (const [id, alias] of Object.entries(incomingAliases)) {
        state.stats.aliasesImported++;
        if (!(id in localAliases)) {
            state.importedAliases[id] = alias;
            state.stats.aliasesAdded++;
            continue;
        }

        if (localAliases[id] === alias) {
            state.stats.aliasesDuplicates++;
            continue;
        }

        state.aliasConflicts.push({ id, local: localAliases[id], imported: alias });
        state.stats.aliasesConflicts++;
        nextResolutions[id] = state.aliasResolutions[id] || 'skip';
    }

    state.aliasResolutions = nextResolutions;
}

function getTags() {
    if (!state.localPlayersJson?.Config) return null;
    const t = {};
    Object.entries(state.localPlayersJson.Config).forEach(([k, v]) => t[k] = v.Name || k);
    return t;
}

function getResolvedAliases(localAliasesRaw = state.localPlayersJson?.Aliases || {}) {
    const localAliases = normalizeAliases(localAliasesRaw);
    const resolved = { ...localAliases, ...state.importedAliases };

    for (const c of state.aliasConflicts) {
        const choice = state.aliasResolutions[c.id] || 'skip';
        if (choice === 'use_imported') resolved[c.id] = c.imported;
        else resolved[c.id] = c.local;
    }

    return resolved;
}

function build() {
    const o = JSON.parse(JSON.stringify(state.localPlayersJson || { Config: {}, Tags: {}, Aliases: {} }));
    if (!o.Tags) o.Tags = {};

    for (const [id, tags] of state.importedDirectTags) {
        if (tags.size) o.Tags[id] = [...tags];
    }

    for (const [id, attrs] of state.importedPlayers) {
        const mapped = [...attrs].map(a => state.attributeMapping[a]).filter(Boolean);
        if (mapped.length) o.Tags[id] = mapped;
    }

    o.Aliases = getResolvedAliases(o.Aliases || {});

    return o;
}

function renderMap() {
    const c = document.getElementById('mapping-container');
    if (!c) return;

    const t = getTags();
    if (!t) {
        c.innerHTML = '<span class="dim">load players.json first</span>';
        return;
    }

    if (!state.allAttributes.size) {
        c.innerHTML = '<span class="dim">import playerlists with attributes (or players.json with Tags)</span>';
        return;
    }

    const cnt = {};
    state.allAttributes.forEach(a => cnt[a] = 0);
    state.importedPlayers.forEach(at => at.forEach(a => cnt[a]++));

    c.innerHTML = '';
    state.allAttributes.forEach(a => {
        const r = document.createElement('div');
        r.className = 'mr';
        const s = document.createElement('select');
        s.innerHTML = '<option value="">skip</option>' +
            Object.entries(t)
                .map(([k, v]) => `<option value="${k}"${state.attributeMapping[a] === k ? ' selected' : ''}>${k}: ${v}</option>`)
                .join('');
        s.onchange = e => state.attributeMapping[a] = e.target.value;
        r.innerHTML = `<span class="n">${a}</span><span class="c">(${cnt[a]})</span>`;
        r.appendChild(s);
        c.appendChild(r);
    });
}

function renderStats() {
    const set = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.textContent = v;
    };

    set('stat-imported', state.stats.imported);
    set('stat-added', state.stats.added);
    set('stat-duplicates', state.stats.duplicates);
    set('stat-aliases-imported', state.stats.aliasesImported);
    set('stat-aliases-added', state.stats.aliasesAdded);
    set('stat-aliases-duplicates', state.stats.aliasesDuplicates);
    set('stat-aliases-conflicts', state.stats.aliasesConflicts);
}

function renderAliases() {
    const c = document.getElementById('aliases-container');
    if (!c) return;

    const resolved = getResolvedAliases();
    const rows = Object.entries(resolved).sort((a, b) => a[0].localeCompare(b[0]));

    if (!rows.length) {
        c.innerHTML = '<span class="dim">no aliases yet</span>';
        return;
    }

    const importedCount = Object.keys(state.importedAliases).length;
    const isExpanded = state.aliasListExpanded;
    const visible = isExpanded ? rows : rows.slice(0, 5);
    const hidden = rows.length - visible.length;

    c.innerHTML =
        `<div class="alias-header">
            <div class="alias-meta">${rows.length} total · ${importedCount} new</div>
            <button class="alias-toggle" id="alias-toggle-btn">${isExpanded ? 'minimize' : 'maximize'} <span class="arr">${isExpanded ? '▾' : '▸'}</span></button>
        </div>
        <div class="alias-list ${isExpanded ? 'expanded' : 'collapsed'}">` +
        visible.map(([id, alias]) => {
            const link = `http://steamcommunity.com/profiles/[U:1:${id}]`;
            return `<div class="alias-row"><a class="alias-inline" href="${link}" target="_blank" rel="noopener noreferrer" title="${alias}"><span class="alias-name">${alias}</span><span class="alias-id">[U:1:${id}]</span></a></div>`;
        }).join('') +
        (hidden > 0 ? `<div class="alias-more">+${hidden} more</div>` : '') +
        '</div>';
}

function setupAliasToggle() {
    const root = document.getElementById('aliases-container');
    if (!root) return;

    root.addEventListener('click', e => {
        const btn = e.target.closest('#alias-toggle-btn');
        if (!btn) return;
        state.aliasListExpanded = !state.aliasListExpanded;
        renderAliases();
    });
}

function renderDb() {
    const c = document.getElementById('loaded-databases');
    if (!c) return;
    c.innerHTML = state.loadedDatabases.map((d, i) =>
        `<div class="db"><span class="n">${d.name}</span> · ${d.players.length + Object.keys(d.tags || {}).length}<button class="x" data-i="${i}">×</button></div>`
    ).join('');
}

function renderAliasConflicts() {
    const c = document.getElementById('alias-conflicts-container');
    if (!c) return;

    if (!state.aliasConflicts.length) {
        c.innerHTML = '<span class="dim">no conflicts</span>';
        return;
    }

    c.innerHTML = state.aliasConflicts.map(x => {
        const choice = state.aliasResolutions[x.id] || 'skip';
        return `<div class="conflict-row" data-id="${x.id}">
            <div class="id">[U:1:${x.id}]</div>
            <div class="vals"><span>local: ${x.local}</span><span>imported: ${x.imported}</span></div>
            <div class="actions">
                <button data-choice="keep_local" class="${choice === 'keep_local' ? 'active' : ''}">keep local</button>
                <button data-choice="use_imported" class="${choice === 'use_imported' ? 'active' : ''}">use imported</button>
                <button data-choice="skip" class="${choice === 'skip' ? 'active' : ''}">skip for now</button>
            </div>
        </div>`;
    }).join('');
}

const refresh = () => {
    process();
    renderDb();
    renderMap();
    renderStats();
    renderAliases();
    renderAliasConflicts();
};

function clearLocal() {
    state.localPlayersJson = null;
    state.attributeMapping = {};
    state.aliasResolutions = {};
    document.getElementById('local-status').innerHTML = '';
    document.getElementById('local-file-input').value = '';
    refresh();
}

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

function setupChangelogToggle() {
    const btn = document.getElementById('changelog-toggle');
    const panel = document.getElementById('changelog-panel');
    if (!btn || !panel) return;

    btn.addEventListener('click', () => {
        const open = panel.classList.toggle('open');
        btn.setAttribute('aria-expanded', String(open));
        panel.setAttribute('aria-hidden', String(!open));
    });
}

document.addEventListener('DOMContentLoaded', () => {
    const $ = id => document.getElementById(id);
    const mU = $('mode-url');
    const mF = $('mode-file');
    const uM = $('url-mode');
    const fM = $('file-mode');

    mU?.addEventListener('click', () => {
        mU.classList.add('active');
        mF.classList.remove('active');
        uM.classList.remove('hide');
        fM.classList.add('hide');
    });

    mF?.addEventListener('click', () => {
        mF.classList.add('active');
        mU.classList.remove('active');
        fM.classList.remove('hide');
        uM.classList.add('hide');
    });

    $('add-url-btn')?.addEventListener('click', async () => {
        const u = $('url-input').value.trim();
        if (!u) return;
        if (state.loadedDatabases.some(db => db.url === u)) {
            alert('already loaded');
            return;
        }

        try {
            const db = await loadUrl(u);
            db.url = u;
            state.loadedDatabases.push(db);
            refresh();
            $('url-input').value = '';
        } catch {
            alert('fail');
        }
    });

    document.querySelectorAll('[data-url]').forEach(b => b.addEventListener('click', async () => {
        const u = b.dataset.url;
        if (state.loadedDatabases.some(db => db.url === u)) {
            alert('already loaded');
            return;
        }

        b.disabled = true;
        try {
            const db = await loadUrl(u);
            db.url = u;
            state.loadedDatabases.push(db);
            refresh();
        } catch {
            alert('fail');
        }
        b.disabled = false;
    }));

    $('loaded-databases')?.addEventListener('click', e => {
        if (e.target.classList.contains('x')) {
            state.loadedDatabases.splice(+e.target.dataset.i, 1);
            refresh();
        }
    });

    $('alias-conflicts-container')?.addEventListener('click', e => {
        if (!e.target.matches('button[data-choice]')) return;
        const row = e.target.closest('.conflict-row');
        if (!row) return;
        state.aliasResolutions[row.dataset.id] = e.target.dataset.choice;
        renderAliasConflicts();
        renderAliases();
    });

    $('local-file-input')?.addEventListener('change', async e => {
        const f = e.target.files[0];
        if (!f) return;

        try {
            const parsed = JSON.parse(await f.text());
            state.localPlayersJson = parsed;
            const tagsCount = Object.keys(parsed.Tags || {}).length;
            const aliasCount = Object.keys(parsed.Aliases || {}).length;
            $('local-status').innerHTML = `<span class="fr">${f.name} (${tagsCount} tags, ${aliasCount} aliases)<button class="x" id="cl">×</button></span>`;
            $('cl').onclick = clearLocal;
            refresh();
        } catch {
            alert('err');
        }
    });

    $('ready-file-input')?.addEventListener('change', async e => {
        const f = e.target.files[0];
        if (!f) return;

        try {
            const d = JSON.parse(await f.text());
            const db = loadFile(f, d);
            state.loadedDatabases.push(db);
            refresh();
            e.target.value = '';
        } catch {
            alert('err');
        }
    });

    $('convert-btn')?.addEventListener('click', download);

    setupAliasToggle();
    setupChangelogToggle();
    refresh();
});
