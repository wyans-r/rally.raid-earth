// Rally Raid Events: the async event pages (list, event, enter, packs, result upload, leaderboard, organizer tools, review,
// admin). Talks to the Worker's /api (worker/src). Plain JavaScript, no framework; hash routes (#/e/<slug>, ...).
;(function () {
  'use strict'
  var app = document.getElementById('app'), who = document.getElementById('who')
  var ME = { user: null, providers: [] }

  // ---------- helpers
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
  function api(method, path, body, raw) {
    var o = { method: method, headers: { 'X-RR': '1' }, credentials: 'same-origin' }
    if (body !== undefined) { o.body = raw ? body : JSON.stringify(body); o.headers['Content-Type'] = 'application/json' }
    return fetch('/api' + path, o).then(function (r) {
      return r.text().then(function (t) {
        var d; try { d = JSON.parse(t) } catch (e) { d = { error: t || r.statusText } }
        if (!r.ok) { var err = new Error(d.error || ('HTTP ' + r.status)); err.status = r.status; throw err }
        return d
      })
    })
  }
  var toastT
  function toast(msg, bad) { var t = document.getElementById('toast'); t.textContent = msg; t.className = bad ? 'err' : ''; t.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(function () { t.style.display = 'none' }, bad ? 7000 : 3500) }
  function fail(e) { toast(e.message || String(e), true) }
  function hms(s) { if (s == null) return '–'; s = Math.round(s); return Math.floor(s / 3600) + ':' + ('0' + Math.floor(s / 60) % 60).slice(-2) + ':' + ('0' + s % 60).slice(-2) }
  function when(iso) {
    if (!iso) return '–'
    var d = new Date(iso)
    return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
  }
  function badge(cls, text, title) { return '<span class="badge b-' + cls + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</span>' }
  var PHASE = { open: 'OPEN', upcoming: 'UPCOMING', closed: 'CLOSED', draft: 'DRAFT (not published)' }
  function canOrganize() { return ME.user && (ME.user.role === 'organizer' || ME.user.role === 'admin') }
  function localToIso(v) { return v ? new Date(v).toISOString().replace(/\.\d{3}Z$/, 'Z') : '' }
  function isoToLocal(iso) { if (!iso) return ''; var d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16) }
  function readFile(f) { return new Promise(function (ok, no) { var r = new FileReader(); r.onload = function () { ok(r.result) }; r.onerror = no; r.readAsText(f) }) }
  function download(name, text) { var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove() }, 500) }

  function renderWho() {
    if (!ME.user) { who.innerHTML = '<a href="#/login">Log in</a>'; return }
    who.innerHTML = '<a href="#/me" title="your account">' + esc(ME.user.name) + '</a>' + (ME.user.role !== 'entrant' ? ' ' + badge(ME.user.role === 'admin' ? 'hc' : 'upcoming', ME.user.role) : '') +
      (ME.user.role === 'admin' ? ' <a href="#/admin">Admin</a>' : '') + ' <a href="#/" id="logout">Log out</a>'
    document.getElementById('logout').onclick = function (ev) { ev.preventDefault(); api('POST', '/auth/logout', {}).then(loadMe).then(function () { location.hash = '#/' }) }
  }
  function loadMe() { return api('GET', '/me').then(function (d) { ME = d; renderWho(); return d }) }

  // ---------- views
  function viewList() {
    return api('GET', '/events').then(function (d) {
      var h = '<h1>Async rally raid events</h1><p class="dim">Drive each stage once, in one sitting, any time while the event is open. Roadbook and GPS only: no route on the map. Results upload from the game, or as a file here.</p>'
      if (canOrganize()) h += '<p><a class="btn go" href="#/new">+ New event</a></p>'
      else if (ME.user && ME.organizerRequest !== 'pending') h += '<p class="small dim">Want to run your own event? <a href="#/me">Ask to become an organizer</a>.</p>'
      if (!d.events.length) h += '<div class="card dim">No events yet.</div>'
      h += '<div class="cards">' + d.events.map(function (e) {
        return '<a class="card" style="text-decoration:none;color:inherit" href="#/e/' + esc(e.slug) + '"><div>' + badge(e.phase, PHASE[e.phase]) + '</div>' +
          '<h3>' + esc(e.name) + '</h3><div class="small dim">' + when(e.opensAt) + ' → ' + when(e.closesAt) + '</div>' +
          '<div class="small">' + e.stageCount + ' stage(s) · ' + e.entryCount + ' entrant(s) · by ' + esc(e.organizer) + '</div></a>'
      }).join('') + '</div>'
      app.innerHTML = h
    })
  }

  function viewLogin(q) {
    var p = ME.providers || []
    var h = '<h1>Log in</h1><p class="dim">You need an account to enter events and upload results. No password: use a one-time code by email, or your Discord account.</p>'
    if (q.error) h += '<div class="card" style="border-color:var(--bad)">' + esc(q.error) + '</div>'
    if (p.indexOf('email') >= 0) h += '<div class="card"><h3>Email code</h3><div class="row"><div><label for="em">Email</label><input id="em" type="email" autocomplete="email" placeholder="you@example.com"></div>' +
      '<div style="flex:0 0 auto"><button id="send" class="go">Send code</button></div></div>' +
      '<div id="codeRow" class="row" style="display:none"><div><label for="code">6-digit code from the email</label><input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></div>' +
      '<div style="flex:0 0 auto"><button id="verify" class="go">Log in</button></div></div></div>'
    if (p.indexOf('discord') >= 0) h += '<div class="card"><h3>Discord</h3><a class="btn" id="discord" href="/api/auth/discord/start">Log in with Discord</a> <span class="small dim">Only your Discord user name and id are read.</span></div>'
    app.innerHTML = h
    var send = document.getElementById('send')
    if (send) {
      send.onclick = function () {
        send.disabled = true
        api('POST', '/auth/email/start', { email: document.getElementById('em').value }).then(function () {
          document.getElementById('codeRow').style.display = ''; document.getElementById('code').focus(); toast('Code sent: check your email (also spam).')
        }).catch(fail).then(function () { send.disabled = false })
      }
      document.getElementById('verify').onclick = function () {
        api('POST', '/auth/email/verify', { email: document.getElementById('em').value, code: document.getElementById('code').value })
          .then(loadMe).then(function () { toast('Logged in.'); location.hash = '#/' }).catch(fail)
      }
    }
    return Promise.resolve()
  }

  function viewMe() {
    if (!ME.user) { location.hash = '#/login'; return Promise.resolve() }
    var u = ME.user
    var h = '<h1>Your account</h1><div class="card"><div class="row"><div><label for="nm">Name on the leaderboards</label><input id="nm" maxlength="40" value="' + esc(u.name) + '"></div>' +
      '<div style="flex:0 0 auto"><button id="saveNm">Save</button></div></div><p class="small dim">Role: ' + esc(u.role) + (u.email ? ' · ' + esc(u.email) : '') + (u.discord ? ' · Discord' : '') + '</p></div>'
    if (u.role === 'entrant') {
      h += '<div class="card"><h3>Become an organizer</h3>' + (ME.organizerRequest === 'pending' ? '<p>Your request is waiting for the admin.</p>' :
        (ME.organizerRequest === 'rejected' ? '<p class="dim">Your last request was not approved. You can ask again.</p>' : '') +
        '<label for="why">Tell the admin what you would like to run</label><textarea id="why" rows="3" maxlength="500"></textarea><p><button id="ask" class="go">Ask to organize</button></p>') + '</div>'
    }
    app.innerHTML = h
    document.getElementById('saveNm').onclick = function () { api('POST', '/me/name', { name: document.getElementById('nm').value }).then(loadMe).then(function () { toast('Saved.') }).catch(fail) }
    var ask = document.getElementById('ask')
    if (ask) ask.onclick = function () { api('POST', '/organizer/request', { note: document.getElementById('why').value }).then(loadMe).then(viewMe).then(function () { toast('Request sent.') }).catch(fail) }
    return Promise.resolve()
  }

  function eventForm(e) {
    e = e || { classes: ['T1 Prototype', 'T3 Light prototype', 'T4 SSV', 'Bike'], rules: { gameCrashResume: {} }, minModVersion: '0.2.0',
      rulesText: 'Dakar-style, roadbook only: no recce, no route on any map. Drive each stage once, in one sitting.\nOfficial mode in the game (Rally Raid Event app). Game-crash resumes are allowed and reviewed.\nRecover car: 3 per rally, 1 per stage, none within 1 km of the finish; 15 min first, 30 min after.\nTrace and replay on request: an organizer may ask for a replay; no answer by the deadline = penalty or DQ.' }
    var g = (e.rules && e.rules.gameCrashResume) || {}
    return '<div class="card"><label for="f_name">Event name</label><input id="f_name" maxlength="100" value="' + esc(e.name || '') + '">' +
      '<div class="row"><div><label for="f_open">Opens (your local time)</label><input id="f_open" type="datetime-local" value="' + isoToLocal(e.opensAt) + '"></div>' +
      '<div><label for="f_close">Closes</label><input id="f_close" type="datetime-local" value="' + isoToLocal(e.closesAt) + '"></div>' +
      '<div><label for="f_rb">Roadbook release (packs downloadable)</label><input id="f_rb" type="datetime-local" value="' + isoToLocal(e.roadbookReleaseAt) + '"></div></div>' +
      '<label for="f_classes">Vehicle classes (one per line)</label><textarea id="f_classes" rows="4">' + esc((e.classes || []).join('\n')) + '</textarea>' +
      '<label for="f_rules">Rules (shown on the event page)</label><textarea id="f_rules" rows="6">' + esc(e.rulesText || '') + '</textarea>' +
      '<div class="row"><div><label for="f_g1">Game-crash resume penalty, first (min)</label><input id="f_g1" type="number" min="0" value="' + Math.round((g.firstPenaltyS || 0) / 60) + '"></div>' +
      '<div><label for="f_g2">… later ones (min)</label><input id="f_g2" type="number" min="0" value="' + Math.round((g.laterPenaltyS || 0) / 60) + '"></div>' +
      '<div><label for="f_mv">Minimum mod version</label><input id="f_mv" value="' + esc(e.minModVersion || '0.2.0') + '"></div></div></div>'
  }
  function readForm() {
    return { name: val('f_name'), opensAt: localToIso(val('f_open')), closesAt: localToIso(val('f_close')), roadbookReleaseAt: localToIso(val('f_rb')),
      classes: val('f_classes').split('\n'), rulesText: val('f_rules'), minModVersion: val('f_mv'),
      rules: { gameCrashResume: { firstPenaltyS: (+val('f_g1') || 0) * 60, laterPenaltyS: (+val('f_g2') || 0) * 60 } } }
  }
  function val(id) { var el = document.getElementById(id); return el ? el.value : '' }

  function viewNew() {
    if (!canOrganize()) { app.innerHTML = '<p>Only organizers can create events. <a href="#/me">Ask to become one</a>.</p>'; return Promise.resolve() }
    app.innerHTML = '<h1>New event</h1><p class="dim">You can change everything until you lock the event. Stage files come next.</p>' + eventForm() + '<button id="create" class="go">Create draft</button>'
    document.getElementById('create').onclick = function () {
      api('POST', '/events', readForm()).then(function (d) { toast('Draft created.'); location.hash = '#/e/' + d.slug }).catch(fail)
    }
    return Promise.resolve()
  }

  function stageTable(ev) {
    if (!ev.stages.length) return '<div class="card dim">No stages yet.</div>'
    return '<div class="tablewrap"><table><thead><tr><th>Stage</th><th>Length</th><th>WPs</th><th>Published SHA-256 (stage / roadbook)</th></tr></thead><tbody>' +
      ev.stages.map(function (s) {
        return '<tr><td><b>SS' + s.idx + '</b> ' + esc(s.name) + (s.known ? ' ' + badge('known', 'known stage', s.knownReason) : '') + '</td><td>' + (s.lengthKm ? s.lengthKm.toFixed(1) + ' km' : '–') + '</td><td>' + (s.waypoints || '') + '</td>' +
          '<td style="white-space:normal"><div class="hash" title="stage file">' + esc(s.stageSha256) + '</div><div class="hash" title="roadbook file">' + esc(s.roadbookSha256 || '–') + '</div></td></tr>'
      }).join('') + '</tbody></table></div>'
  }

  function lbTable(rows, stages, hc) {
    if (!rows.length) return '<p class="dim small">No entrants yet.</p>'
    return '<div class="tablewrap"><table><thead><tr><th>#</th><th>Driver</th>' + stages.map(function (s) { return '<th title="' + esc(s.name) + '">SS' + s.idx + (s.known ? '*' : '') + '</th>' }).join('') + '<th>Total</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td>' + (r.pos || '') + '</td><td>' + esc(r.name) + (r.vehicle ? '<div class="small dim">' + esc(r.vehicle) + '</div>' : '') + '</td>' +
          r.stages.map(function (s) { return '<td class="t">' + (s.retired ? '<span title="' + esc(s.retired) + '">DNF</span>' : s.total != null ? hms(s.total) + (s.reviewed ? '<sup title="approved after review">r</sup>' : '') : (s.pending ? '<span class="dim" title="waiting for review">review</span>' : '–')) + '</td>' }).join('') +
          '<td class="t"><b>' + (r.overall != null ? hms(r.overall) : '–') + '</b></td></tr>'
      }).join('') + '</tbody></table></div>'
  }

  function viewEvent(slug) {
    return Promise.all([api('GET', '/events/' + encodeURIComponent(slug)), api('GET', '/events/' + encodeURIComponent(slug) + '/leaderboard').catch(function () { return null })]).then(function (x) {
      var ev = x[0].event, lb = x[1] && x[1].leaderboard
      var my = ev.myEntry
      var h = '<p class="small"><a href="#/">← all events</a></p><h1>' + esc(ev.name) + ' ' + badge(ev.phase, PHASE[ev.phase]) + '</h1>' +
        '<div class="kv"><div>Opens</div><div>' + when(ev.opensAt) + '</div><div>Closes</div><div>' + when(ev.closesAt) + '</div>' +
        '<div>Roadbook release</div><div>' + when(ev.roadbookReleaseAt) + '</div><div>Classes</div><div>' + ev.classes.map(esc).join(' · ') + '</div>' +
        '<div>Organizer</div><div>' + esc(ev.organizer) + ' <span class="small dim">(drives hors classement)</span></div><div>Mod</div><div>' + esc(ev.minModVersion) + ' or newer · <a href="/mod">download</a></div>' +
        (ev.lockHash ? '<div>Event hash</div><div class="hash">' + esc(ev.lockHash) + '</div><div>Locked</div><div>' + when(ev.lockedAt) + '</div>' : '') + '</div>'
      h += '<h2>Stages</h2>' + stageTable(ev)
      if (ev.stages.some(function (s) { return s.known })) h += '<p class="small dim">* known stage: an example or earlier stage some drivers may already know.</p>'
      h += '<h2>Rules</h2><div class="card"><pre class="rules">' + esc(ev.rulesText || '') + '</pre></div>'

      // entrant panel
      if (ev.status === 'locked') {
        h += '<h2>Your entry</h2>'
        if (!ME.user) h += '<div class="card"><a href="#/login">Log in</a> to enter.</div>'
        else if (ev.phase === 'closed') h += '<div class="card dim">The event is closed.</div>'
        else {
          h += '<div class="card"><div class="row"><div><label for="cls">Class</label><select id="cls">' + ev.classes.map(function (c) { return '<option' + (my && my.class === c ? ' selected' : '') + '>' + esc(c) + '</option>' }).join('') + '</select></div>' +
            '<div><label for="veh">Vehicle (as in the game)</label><input id="veh" maxlength="80" value="' + esc(my ? my.vehicle || '' : '') + '"></div>' +
            '<div style="flex:0 0 auto"><button id="enter" class="go">' + (my ? 'Update entry' : 'Enter') + '</button></div></div>' +
            (my && my.hc ? '<p class="small">' + badge('hc', 'HORS CLASSEMENT') + ' You organize this event: your times show apart from the classification.</p>' : '') + '</div>'
          if (my) {
            h += '<div class="card"><h3>1. Event packs (one per stage)</h3>' + (ev.packsReleased || ev.canManage ?
              '<p class="small dim">Save each file in <b>Documents/BeamNG.drive/current/rallyraid/events/</b> (the BeamNG user folder), then in the game open the <b>Rally Raid Event</b> app and press LOAD. The pack holds your personal upload key: do not share it.</p>' +
              ev.stages.map(function (s) { return '<button class="pack" data-idx="' + s.idx + '">⬇ SS' + s.idx + ' ' + esc(s.name) + '</button> ' }).join('')
              : '<p>The roadbook is released ' + when(ev.roadbookReleaseAt) + '.</p>') + '</div>'
            h += '<div class="card"><h3>2. Your results</h3><p class="small dim">The game uploads each result at the finish. If it could not, drop the <b>.rrresult.json</b> file from <b>rallyraid/results/official/</b> here.</p>' +
              '<div class="drop" id="drop" tabindex="0">Drop the result file here, or tap to choose it<input id="file" type="file" accept=".json,application/json" style="display:none"></div>' +
              (my.results && my.results.length ? '<div class="tablewrap"><table><thead><tr><th>Stage</th><th>Status</th><th>Time</th><th>Via</th><th>Received</th></tr></thead><tbody>' + my.results.map(function (r) {
                return '<tr><td>SS' + r.stage_idx + (r.attempt > 1 ? ' (try ' + r.attempt + ')' : '') + '</td><td>' + badge(r.status, r.status) + '</td><td class="t">' + hms(r.total_time) + '</td><td>' + esc(r.via) + '</td><td><a href="#/r/' + esc(r.id) + '">' + when(r.received_at) + '</a></td></tr>'
              }).join('') + '</tbody></table></div>' : '<p class="dim small">No results yet.</p>') + '</div>'
          }
        }
      }

      // leaderboard
      if (lb) {
        h += '<h2>Leaderboard</h2><div class="lb"><div>' + lb.classes.map(function (c) { return '<div class="card"><h3>' + esc(c.class) + '</h3>' + lbTable(c.rows, lb.stages) + '</div>' }).join('') + '</div>' +
          '<div><div class="card hc"><h3>Hors classement ' + badge('hc', 'organizer') + '</h3><p class="small dim">The organizer\'s own runs: not ranked.</p>' + lbTable(lb.horsClassement, lb.stages, true) + '</div></div></div>' +
          '<p class="small dim">Times include penalties. "review": a result waits for the organizer. Results are checked automatically (file hashes, waypoint order, GPS trace); anything unusual goes to the organizer, never straight to a DQ.</p>'
      }

      // organizer tools
      if (ev.canManage) {
        h += '<h2>Organizer</h2>'
        if (ev.status === 'draft') {
          h += '<div class="card"><h3>Stage files</h3><p class="small dim">Each stage: the stage file (.json from the stage builder) and its roadbook (.roadbook.json from the roadbook editor). The exact bytes are stored and hashed.</p>' +
            '<div class="row"><div><label for="s_idx">Stage number</label><input id="s_idx" type="number" min="1" max="20" value="' + (ev.stages.length + 1) + '"></div><div><label for="s_name">Name</label><input id="s_name" placeholder="SS1 …"></div></div>' +
            '<div class="row"><div><label for="s_file">Stage file</label><input id="s_file" type="file" accept=".json"></div><div><label for="s_rb">Roadbook file</label><input id="s_rb" type="file" accept=".json"></div></div>' +
            '<label><input id="s_known" type="checkbox" style="width:auto;min-height:0"> known stage (drivers may have driven it before)</label><p><button id="s_put" class="go">Add / replace stage</button></p></div>'
          h += '<h3>Event details</h3>' + eventForm(ev) + '<p><button id="save">Save details</button> <button id="del" class="bad">Delete draft</button></p>'
          h += '<div class="card" style="border-color:var(--acc)"><h3>Lock and publish</h3><p>Locking publishes the event with the SHA-256 hash of every file. After that nothing can change: the game refuses files that do not match, and the website checks every result against them.</p><button id="lock" class="go">Lock and publish</button></div>'
        } else {
          h += '<div class="card"><p>Locked: files and rules are fixed. ' + (ev.pendingReview ? '<b>' + ev.pendingReview + ' result(s) wait for review.</b> ' : '') + '<a class="btn" href="#/e/' + esc(ev.slug) + '/review">Review results</a></p></div>'
        }
      }
      app.innerHTML = h
      wireEvent(ev)
    })
  }

  function wireEvent(ev) {
    var on = function (id, f) { var el = document.getElementById(id); if (el) el.onclick = f }
    var reload = function () { return route() }
    on('enter', function () { api('POST', '/events/' + ev.id + '/enter', { class: val('cls'), vehicle: val('veh') }).then(function (d) { toast(d.hc ? 'Entered (hors classement).' : 'Entered.'); reload() }).catch(fail) })
    Array.prototype.forEach.call(document.querySelectorAll('button.pack'), function (b) {
      b.onclick = function () {
        fetch('/api/events/' + ev.id + '/stages/' + b.dataset.idx + '/pack', { credentials: 'same-origin' }).then(function (r) {
          return r.text().then(function (t) { if (!r.ok) throw new Error((JSON.parse(t) || {}).error || r.status); download(ev.slug + '-ss' + b.dataset.idx + '.rrevent.json', t); toast('Pack saved: put it in rallyraid/events/.') })
        }).catch(fail)
      }
    })
    var drop = document.getElementById('drop'), file = document.getElementById('file')
    if (drop) {
      var up = function (f) {
        if (!f) return
        readFile(f).then(function (t) { return api('POST', '/events/' + ev.id + '/results', t, true) }).then(function (d) {
          toast(d.duplicate ? 'Already uploaded (' + d.status + ').' : d.status === 'pass' ? 'Result accepted: on the leaderboard.' : 'Result received: flagged for the organizer (' + (d.failed || []).join(', ') + ').'); reload()
        }).catch(fail)
      }
      drop.onclick = function () { file.click() }
      drop.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') file.click() }
      file.onchange = function () { up(file.files[0]) }
      drop.ondragover = function (e) { e.preventDefault(); drop.classList.add('over') }
      drop.ondragleave = function () { drop.classList.remove('over') }
      drop.ondrop = function (e) { e.preventDefault(); drop.classList.remove('over'); up(e.dataTransfer.files[0]) }
    }
    on('s_put', function () {
      var sf = document.getElementById('s_file').files[0], rf = document.getElementById('s_rb').files[0]
      if (!sf || !rf) return toast('Pick both files.', true)
      Promise.all([readFile(sf), readFile(rf)]).then(function (t) {
        return api('PUT', '/events/' + ev.id + '/stages/' + val('s_idx'), { name: val('s_name'), stageText: t[0], roadbookText: t[1], known: document.getElementById('s_known').checked })
      }).then(function (d) { toast('Stage stored' + (d.known ? ' (known stage: ' + d.knownReason + ')' : '') + '.'); reload() }).catch(fail)
    })
    on('save', function () { api('PUT', '/events/' + ev.id, readForm()).then(function () { toast('Saved.'); reload() }).catch(fail) })
    on('del', function () { if (confirm('Delete this draft event?')) api('DELETE', '/events/' + ev.id).then(function () { location.hash = '#/' }).catch(fail) })
    on('lock', function () {
      if (!confirm('Lock and publish "' + ev.name + '"? Files and rules cannot change after this.')) return
      api('POST', '/events/' + ev.id + '/lock', {}).then(function (d) { toast('Locked. Event hash ' + d.lockHash.slice(0, 12) + '…'); reload() }).catch(fail)
    })
  }

  function viewReview(slug) {
    return Promise.all([api('GET', '/events/' + encodeURIComponent(slug)), api('GET', '/events/' + encodeURIComponent(slug) + '/review')]).then(function (x) {
      var ev = x[0].event, rs = x[1].results
      var h = '<p class="small"><a href="#/e/' + esc(ev.slug) + '">← ' + esc(ev.name) + '</a></p><h1>Review results</h1><p class="dim">Flagged first. Nothing is rejected automatically: open a result, read the checks and the trace, then decide.</p>'
      if (!rs.length) h += '<div class="card dim">No results yet.</div>'
      h += '<div class="tablewrap"><table><thead><tr><th>Status</th><th>Driver</th><th>Stage</th><th>Time</th><th>What to look at</th></tr></thead><tbody>' + rs.map(function (r) {
        var bad = r.checks.filter(function (c) { return !c.ok && c.level !== 'info' })
        return '<tr><td>' + badge(r.status, r.status) + '</td><td>' + esc(r.display_name) + '<div class="small dim">' + esc(r.class) + '</div></td><td>SS' + r.stage_idx + (r.attempt > 1 ? ' try ' + r.attempt : '') + '</td><td class="t">' + hms(r.total_time) + '</td>' +
          '<td style="white-space:normal"><a href="#/r/' + esc(r.id) + '">' + (bad.length ? bad.map(function (c) { return esc(c.msg) }).join('<br>') : 'all checks passed') + '</a></td></tr>'
      }).join('') + '</tbody></table></div>'
      app.innerHTML = h
    })
  }

  function traceSvg(trace, wps) {
    if (!trace.length) return ''
    var pts = trace.map(function (p) { return [p[2], p[3]] }).concat(wps.map(function (w) { return [w.lat, w.lon] }))
    var la = pts.map(function (p) { return p[0] }), lo = pts.map(function (p) { return p[1] })
    var minLa = Math.min.apply(0, la), maxLa = Math.max.apply(0, la), minLo = Math.min.apply(0, lo), maxLo = Math.max.apply(0, lo)
    var k = Math.cos((minLa + maxLa) / 2 * Math.PI / 180), W = 600, pad = 14
    var sx = (maxLo - minLo) * k || 1e-6, sy = (maxLa - minLa) || 1e-6, s = (W - 2 * pad) / Math.max(sx, sy), H = Math.round(sy * s + 2 * pad)
    var X = function (lon) { return (pad + (lon - minLo) * k * s).toFixed(1) }, Y = function (lat) { return (H - pad - (lat - minLa) * s).toFixed(1) }
    var path = trace.map(function (p, i) { return (i ? 'L' : 'M') + X(p[3]) + ' ' + Y(p[2]) }).join('')
    var marks = wps.map(function (w) { var c = w.type === 'DSS' ? '#4caf50' : w.type === 'ASS' ? '#ff5252' : '#ffb000'; return '<circle cx="' + X(w.lon) + '" cy="' + Y(w.lat) + '" r="4" fill="' + c + '"><title>' + esc(w.type + ' ' + w.n) + '</title></circle>' }).join('')
    return '<svg class="trace" viewBox="0 0 ' + W + ' ' + H + '"><path d="' + path + '" fill="none" stroke="#7cc4ff" stroke-width="1.6"/>' + marks + '</svg>'
  }

  function viewResult(id) {
    return api('GET', '/results/' + encodeURIComponent(id)).then(function (d) {
      var r = d.result, det = d.detail || {}
      var h = '<p class="small"><a href="javascript:history.back()">← back</a></p><h1>' + esc(r.display_name) + ' · SS' + r.stage_idx + ' ' + badge(r.status, r.status) + '</h1>' +
        '<div class="kv"><div>Total</div><div class="t">' + hms(r.total_time) + ' <span class="dim">(stage ' + hms(r.stage_time) + ' + penalties ' + hms(r.penalty_time) + (r.review_penalty ? ' + review ' + hms(r.review_penalty) : '') + ')</span></div>' +
        '<div>Driven</div><div>' + when(det.startedAt) + ' → ' + when(det.finishedAt) + '</div><div>Vehicle</div><div>' + esc(det.vehicle || '–') + ' · mod ' + esc(det.modVersion || '?') + '</div>' +
        '<div>Uploaded</div><div>' + when(r.received_at) + ' via ' + esc(r.via) + (r.attempt > 1 ? ' · attempt ' + r.attempt : '') + '</div>' +
        '<div>Package</div><div class="hash">' + esc(r.package_sha256) + '</div>' + (r.review_note ? '<div>Organizer note</div><div>' + esc(r.review_note) + '</div>' : '') + '</div>'
      h += '<h2>Checks</h2><div class="card">' + r.checks.map(function (c) { return '<div class="check ' + (c.level === 'info' ? 'info' : c.ok ? 'ok' : 'no ' + c.level) + '">' + esc(c.msg) + '</div>' }).join('') + '</div>'
      if (det.gameCrashResume && det.gameCrashResume.count) h += '<h2>Game-crash resumes</h2><div class="card">' + (det.gameCrashResume.review || []).map(function (s) { return '<div class="check no review">' + esc(s) + '</div>' }).join('') + '</div>'
      h += '<h2>GPS trace</h2>' + traceSvg(d.trace, d.waypoints) + '<p class="small dim">' + d.trace.length + ' points. Blue: the driven trace; green DSS, amber waypoints, red ASS.</p>'
      if (det.penalties && det.penalties.length) h += '<h2>Penalties</h2><div class="card">' + det.penalties.map(function (p) { return '<div class="check info">' + esc(p.detail || p.kind) + ' (+' + hms(p.seconds) + ')</div>' }).join('') + '</div>'
      if (r.can_review !== false && ME.user && (ME.user.role === 'admin' || ME.user.role === 'organizer')) {
        h += '<h2>Decision</h2><div class="card" id="decide"><div class="row"><div><label for="d_pen">Extra penalty (min, on approve)</label><input id="d_pen" type="number" min="0" value="0"></div></div>' +
          '<label for="d_note">Note (the entrant sees it)</label><textarea id="d_note" rows="2"></textarea>' +
          '<p><button id="d_ok" class="go">Approve</button> <button id="d_no" class="bad">Reject</button> <button id="d_re">Back to review</button></p></div>'
      }
      app.innerHTML = h
      var dec = function (decision) {
        api('POST', '/results/' + r.id + '/review', { decision: decision, penaltyS: (+val('d_pen') || 0) * 60, note: val('d_note') }).then(function (x) { toast('Result ' + x.status + '.'); route() }).catch(fail)
      }
      var b
      if ((b = document.getElementById('d_ok'))) b.onclick = function () { dec('approve') }
      if ((b = document.getElementById('d_no'))) b.onclick = function () { dec('reject') }
      if ((b = document.getElementById('d_re'))) b.onclick = function () { dec('reopen') }
    })
  }

  function viewAdmin() {
    return api('GET', '/admin/organizer-requests').then(function (d) {
      var h = '<h1>Admin</h1><h2>Organizer requests</h2>'
      if (!d.requests.length) h += '<div class="card dim">No requests.</div>'
      h += d.requests.map(function (r) {
        return '<div class="card"><b>' + esc(r.display_name) + '</b> <span class="small dim">' + esc(r.email || (r.discord_id ? 'Discord ' + r.discord_id : '')) + ' · ' + when(r.created_at) + '</span> ' + badge(r.status === 'pending' ? 'flagged' : r.status === 'approved' ? 'pass' : 'rejected', r.status) +
          '<p>' + esc(r.note || '') + '</p>' + (r.status === 'pending' ? '<button class="go dec" data-id="' + esc(r.id) + '" data-d="approve">Approve</button> <button class="bad dec" data-id="' + esc(r.id) + '" data-d="reject">Reject</button>' : '') + '</div>'
      }).join('')
      h += '<h2>Organizers</h2><div class="tablewrap"><table><tbody>' + d.organizers.map(function (u) {
        return '<tr><td>' + esc(u.display_name) + '</td><td>' + esc(u.email || (u.discord_id ? 'Discord' : '')) + '</td><td>' + esc(u.role) + '</td><td>' + (u.role === 'organizer' ? '<button class="revoke" data-id="' + esc(u.id) + '">Remove organizer</button>' : '') + '</td></tr>'
      }).join('') + '</tbody></table></div>'
      app.innerHTML = h
      Array.prototype.forEach.call(document.querySelectorAll('button.dec'), function (b) { b.onclick = function () { api('POST', '/admin/organizer-requests/' + b.dataset.id, { decision: b.dataset.d }).then(function () { toast('Done.'); route() }).catch(fail) } })
      Array.prototype.forEach.call(document.querySelectorAll('button.revoke'), function (b) { b.onclick = function () { if (confirm('Remove the organizer role?')) api('POST', '/admin/users/' + b.dataset.id + '/role', { role: 'entrant' }).then(function () { route() }).catch(fail) } })
    })
  }

  // ---------- router
  function route() {
    var hash = location.hash.replace(/^#/, '') || '/'
    var qi = hash.indexOf('?'), q = {}
    if (qi >= 0) { new URLSearchParams(hash.slice(qi + 1)).forEach(function (v, k) { q[k] = v }); hash = hash.slice(0, qi) }
    var p = hash.split('/').filter(Boolean), m
    var go
    if (!p.length) go = viewList()
    else if (p[0] === 'login') go = viewLogin(q)
    else if (p[0] === 'me') go = viewMe()
    else if (p[0] === 'new') go = viewNew()
    else if (p[0] === 'admin') go = viewAdmin()
    else if (p[0] === 'e' && p[1] && p[2] === 'review') go = viewReview(p[1])
    else if (p[0] === 'e' && p[1]) go = viewEvent(p[1])
    else if (p[0] === 'r' && p[1]) go = viewResult(p[1])
    else go = viewList()
    return Promise.resolve(go).catch(function (e) {
      if (e.status === 401) { location.hash = '#/login'; return }
      app.innerHTML = '<div class="card" style="border-color:var(--bad)">' + esc(e.message) + '</div><p><a href="#/">All events</a></p>'
    }).then(function () { window.scrollTo(0, 0) })
  }
  window.addEventListener('hashchange', route)
  loadMe().catch(function () {}).then(route)
})()
