// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and renders
// the ranked board, a filterable and sortable table, a model sandbox that re-ranks the board live, a
// per-protocol detail drawer with the model's own inputs and the protocol's farm plan, and the
// calibration table the multiple comes from. No network: every byte it shows is in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var MODEL = DATA.model;
  var state = {
    q: '', category: 'all', chain: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null,
    sandbox: { size_slope_adjustment: MODEL.size_slope_adjustment, value_scale: MODEL.value_scale }
  };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMult(n) { return 'x' + n.toFixed(2); }

  // Recompute estimates from each row's fitted peer multiple. Filters preserve the global rank.
  function impliedOf(row, c) {
    var x = Math.log(row.tvl_usd / DATA.calibration.anchor_tvl_usd);
    var slope = DATA.calibration.slope + c.size_slope_adjustment;
    var multiple = Math.max(0.0001, Math.min(10,
      Math.exp(DATA.calibration.log_intercept + slope * x) * c.value_scale));
    return Math.max(1, Math.min(100000000000000, Math.round(row.tvl_usd * multiple)));
  }
  function boardConstants() {
    return { size_slope_adjustment: MODEL.size_slope_adjustment, value_scale: MODEL.value_scale };
  }
  function sandboxActive() {
    var s = state.sandbox;
    return s.size_slope_adjustment !== MODEL.size_slope_adjustment || s.value_scale !== MODEL.value_scale;
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    state.q = params.get('q') || '';
    state.selected = params.get('p') || null;
    state.category = params.get('category') || 'all';
    state.chain = params.get('chain') || 'all';
    state.tab = params.get('tab') || 'pre-token';
    state.sort = params.get('sort') || 'implied';
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.sort !== 'implied') params.set('sort', state.sort);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  // Score the full board first so filtering and secondary sorts never change a protocol's rank.
  function viewRows() {
    var active = sandboxActive();
    var q = state.q.trim().toLowerCase();
    var scored = DATA.rows.map(function (r) {
      var value = active ? impliedOf(r, state.sandbox) : r.implied_value_usd;
      var scale = r.implied_value_usd > 0 ? value / r.implied_value_usd : 1;
      return { row: r, value: value, low: r.peer_range_low_usd * scale, high: r.peer_range_high_usd * scale };
    });
    scored.slice().sort(function (a, b) { return b.value - a.value || (a.row.slug < b.row.slug ? -1 : 1); })
      .forEach(function (item, i) { item.score_rank = i + 1; });
    scored = scored.filter(function (item) {
      var r = item.row;
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (!q) return true;
      return [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    var key = state.sort;
    scored.sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.row.name.toLowerCase(); bv = b.row.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.row.tvl_usd; bv = b.row.tvl_usd; }
      else if (key === 'growth') { av = a.row.change_7d === null ? -Infinity : a.row.change_7d; bv = b.row.change_7d === null ? -Infinity : b.row.change_7d; }
      else if (key === 'age') { av = a.row.age_days === null ? Infinity : a.row.age_days; bv = b.row.age_days === null ? Infinity : b.row.age_days; }
      else if (key === 'chains') { av = (a.row.chains || []).length; bv = (b.row.chains || []).length; }
      else { av = a.value; bv = b.value; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.row.slug < b.row.slug ? -1 : a.row.slug > b.row.slug ? 1 : 0;
    });
    return scored;
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'TOKEN RADAR' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.board_size + ' pre-token protocols ranked by a market-cap peer curve' }),
        el('p', { text: 'The board covers all ' + DATA.watchlist_size + ' watchlist protocols and adds ' + DATA.above_floor_size + ' above-floor and ' + DATA.early_size + ' early protocols. Estimates use listed-token peers from the same frozen DefiLlama snapshot; launch timing and future token value are not observed.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Above the floor, off the watchlist' }), el('b', { text: String(DATA.above_floor_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Median peer miss · leave one out' }), el('b', { text: fmtMult(DATA.calibration.leave_one_out_median_miss_factor) })),
        el('div', { class: 'fact' }, el('span', { text: 'Median peer miss · earlier listings' }), el('b', { text: fmtMult(DATA.calibration.walk_forward_median_miss_factor) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token protocols set aside' }), el('b', { text: String(DATA.live_size) }))
      )
    );
  }

  function slider(key, label, min, max, step) {
    var input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(state.sandbox[key]), 'aria-label': label });
    var value = el('b', { text: key === 'value_scale' ? fmtMult(state.sandbox[key]) : state.sandbox[key].toFixed(2) });
    input.addEventListener('input', function () {
      state.sandbox[key] = parseFloat(input.value);
      value.textContent = key === 'value_scale' ? fmtMult(state.sandbox[key]) : state.sandbox[key].toFixed(2);
      render();
    });
    return el('div', { class: 'slider' }, el('label', null, el('span', { text: label }), value), input);
  }

  function sandboxPanel() {
    var active = sandboxActive();
    var reset = el('button', { class: 'button ghost', type: 'button', text: 'Reset to the board model', onclick: function () { state.sandbox = boardConstants(); render(); } });
    return el('section', { class: 'panel sandbox' },
      el('div', { class: 'sandbox-head' },
        el('h2', { text: 'Model sandbox' }),
        active ? el('span', { class: 'sandbox-badge', text: 'scenario: board re-ranked live' }) : el('span', { class: 'sub', text: 'adjust the fitted curve to explore scenarios' })
      ),
      el('p', { class: 'sub', text: 'Rankings use a Theil–Sen fit of log(market cap / TVL) against log(TVL / $' + fmtUsd(DATA.calibration.anchor_tvl_usd).replace('$', '') + '). Scenarios adjust the fitted slope or cap analogue; filters preserve global rank.' }),
      el('div', { class: 'sliders' },
        slider('size_slope_adjustment', 'Size slope adjustment', -0.5, 0.5, 0.05),
        slider('value_scale', 'Value scenario', 0.5, 2, 0.05)
      ),
      el('div', null, reset)
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var catSelect = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    catSelect.addEventListener('change', function () { state.category = catSelect.value; writeHash(); render(); });
    var chainSelect = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    chainSelect.addEventListener('change', function () { state.chain = chainSelect.value; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; writeHash(); render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; writeHash(); render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), catSelect),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSelect),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? filteredRows().length + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } writeHash(); render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    var list = viewRows();
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category or chain to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; writeHash(); render(); } })
      ));
    }
    var active = sandboxActive();
    var max = list[0].value || 1;
    var tbody = el('tbody');
    list.forEach(function (item, i) {
      var r = item.row;
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var rankCell = active || state.sort !== 'implied'
        ? el('td', { class: 'num' }, el('div', null, el('span', { text: String(item.score_rank) }), el('div', { class: 'sub', text: 'board #' + r.rank })))
        : el('td', { class: 'num', text: String(item.score_rank) });
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        rankCell,
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') + (r.chains && r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((item.value / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(item.value) })
        )),
        el('td', { class: 'peer-band', text: fmtUsd(item.low) + ' – ' + fmtUsd(item.high) }),
        el('td', { class: 'num', text: fmtMult(r.base_multiple) }),
        el('td', null, el('span', { class: 'status', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: active ? 'Sandbox ranking: every row re-scored under the sandbox constants. The board rank is shown under each sandbox rank.' : 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Rank' }),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Cap analogue'),
            el('th', { scope: 'col', text: 'Peer error band' }),
            el('th', { scope: 'col', text: 'Cap / TVL' }),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status live', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking, and their mcap/TVL ratios calibrate it.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    var cal = DATA.calibration;
    var rows = [
      ["Leave one out", cal.leave_one_out_count, cal.leave_one_out_median_miss_factor, cal.global_leave_one_out_median_miss_factor],
      ["Earlier listings only", cal.walk_forward_count, cal.walk_forward_median_miss_factor, cal.global_walk_forward_median_miss_factor]
    ].map(function (r) {
      return el("tr", null, el("td", { text: r[0] }), el("td", { class: "num", text: String(r[1]) }),
        el("td", { class: "num", text: fmtMult(r[2]) }), el("td", { class: "num", text: fmtMult(r[3]) }));
    });
    return el("section", { class: "panel model" },
      el("h2", { text: "Model audit" }),
      el("p", { class: "sub", text: "A robust size curve fits listed-token peers in this frozen snapshot. It does not claim to predict if or when a pre-token protocol launches." }),
      el("div", { class: "formula", text: "Cap analogue = TVL x exp(intercept + beta x ln(TVL / " + fmtUsd(cal.anchor_tvl_usd) + ")); beta = " + cal.slope.toFixed(3) }),
      el("p", { class: "sub", text: "Fit: median pairwise slope of log(mcap / TVL) against log(TVL); intercept: median residual. " + cal.live_count + " listed-token peers have positive TVL and market cap and a known listing date. The 10th-90th percentile peer-error band comes from leave-one-out residuals; it is not a future-launch confidence interval." }),
      el("h3", { text: "Held-out median valuation miss; lower is better" }),
      el("div", { class: "table-wrap" }, el("table", { class: "calib validation" },
        el("thead", null, el("tr", null, el("th", { scope: "col", text: "Evaluation" }), el("th", { scope: "col", text: "Peers" }), el("th", { scope: "col", text: "Radar-3 curve" }), el("th", { scope: "col", text: "Global median baseline" }))),
        el("tbody", null, rows))),
      el("p", { class: "sub", text: "The ordered test predicts later listing cohorts using strictly earlier peers. This one cross-section is not a launch-history backtest. Pre-token means the snapshot has no market cap, CoinGecko id, or symbol recorded; it is not proof that a token does not exist." })
    );
  }
  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var active = sandboxActive();
    var recomputed = impliedOf(row, boardConstants());
    var sandboxValue = active ? impliedOf(row, state.sandbox) : null;
    var displayedValue = active ? sandboxValue : row.implied_value_usd;
    var rangeScale = row.implied_value_usd > 0 ? displayedValue / row.implied_value_usd : 1;
    var check = recomputed === row.implied_value_usd
      ? 'The page recomputes this row as ' + fmtUsd(recomputed) + ', the same number board.json carries.'
      : 'The page recomputes this row as ' + fmtUsd(recomputed) + ', which differs from the board: the data would be stale.';
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'RANK ' + row.rank + ' OF ' + DATA.board_size + (active ? '  |  SCENARIO ' + fmtUsd(sandboxValue) : '') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Market-cap peer analogue' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL in frozen snapshot' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Fitted cap / TVL multiple at this size' }), el('b', { class: 'num', text: fmtMult(row.base_multiple) })),
        el('div', null, el('span', { text: 'Fitted size slope' }), el('b', { class: 'num', text: row.size_slope.toFixed(3) })),
        el('div', null, el('span', { text: 'Seven-day TVL change (context only)' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Peer-error band, leave-one-out' }), el('b', { class: 'num', text: fmtUsd(row.peer_range_low_usd * rangeScale) + ' - ' + fmtUsd(row.peer_range_high_usd * rangeScale) })),
        el('div', null, el('span', { text: active ? 'Scenario cap analogue' : 'Cap analogue' }), el('b', { class: 'num', text: fmtUsd(displayedValue) }))
      ),
      el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': ' + check + ' The peer band is not a launch forecast or confidence interval. Age, chain count and recent growth are context only, not model inputs.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Activity plan (heuristic)' }),
      el('ol', { class: 'steps' }, row.farm_steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function footer() {
    return el('p', { class: 'foot', text: 'Snapshot: ' + DATA.as_of + '. The peer curve estimates a market-cap analogue from listed-token peers. It does not estimate launch odds, timing, future returns or incentives. Missing token fields are not proof that a token does not exist. Activity plans are generic scenarios; verify official incentives, contracts, fees and risks before acting.' });
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(modelPanel());
    shell.appendChild(sandboxPanel());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    shell.appendChild(footer());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  // A hash change (back/forward, or a pasted deep link) re-reads the state and re-renders, so a
  // detail link opens its drawer even when the page is already loaded.
  window.addEventListener('hashchange', function () {
    readHash();
    render();
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
