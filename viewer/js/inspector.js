/**
 * The inspector: pick a building, a folder or a district and read what it is.
 *
 * Every number comes from the analysis, never guessed in the browser, and every
 * number is *explained*: the panel says what the thing you clicked is made of
 * ("2 floors = 2 top-level definitions: parse, Walker"), who built it and who
 * last worked on it, how busy it is, and -- in "Architect's notes" -- the one
 * or two things an architect would change about it, each with the rule that
 * raised it. Fields whose metric family was switched off by the confidence
 * rules say so instead of rendering a meaningless zero.
 */

import { archetypeLabel } from './city.js';

export function formatBytes(value) {
  if (value === null || value === undefined) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return unit === 0 ? `${size} B` : `${size.toFixed(1)} ${units[unit]}`;
}

const plural = (n, one, many = /(s|sh|ch|x)$/.test(one) ? `${one}es` : `${one}s`) => `${Number(n || 0).toLocaleString()} ${n === 1 ? one : many}`;
const pct = (value) => `${Math.round((value || 0) * 100)}%`;

/** "about 3 months" for a day count, never "93.4 days". */
export function humanDays(days) {
  const d = Math.max(0, Math.round(days || 0));
  if (d < 1) return 'the same day';
  if (d < 14) return plural(d, 'day');
  if (d < 60) return `${Math.round(d / 7)} weeks`;
  if (d < 730) return `${Math.round(d / 30.4)} months`;
  return `${(d / 365).toFixed(1)} years`;
}

/** "3 months before the latest commit", or "on the day of the latest commit". */
function beforeHead(days) {
  return Math.round(days || 0) < 1
    ? 'on the day of the repository’s latest commit'
    : `${humanDays(days)} before the repository’s latest commit`;
}

/** What each form is, in a sentence, for the "What you're looking at" line. */
const FORM_MEANING = {
  tower: 'a tower: taller than three quarters of the code files',
  slab: 'a slab: mid-height, the working stock of the city',
  warehouse: 'a warehouse: a low, broad file',
  park: 'a park: test code is green space, not towers',
  silo: 'a silo: a data file, height counts rows',
  monument: 'a monument: a binary artefact with no source to read',
  town_hall: 'a town hall: this folder’s README, its public notice board',
  ruin: 'a ruin: a file the repository ignores (--include-noise)',
};

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** A labelled value with an optional plain-language gloss beneath it. */
function fact(label, value, gloss) {
  return el('div', { className: 'insp-fact' }, [
    el('span', { className: 'insp-label', textContent: label }),
    el('span', { className: 'insp-value', textContent: value }),
    gloss ? el('span', { className: 'insp-gloss', textContent: gloss }) : null,
  ]);
}

function section(title, children, open = true) {
  const details = el('details', { className: 'insp-section', open });
  details.append(el('summary', { textContent: title }));
  for (const child of children) if (child) details.append(child);
  return details;
}

function sparkline(activity) {
  if (!activity || !activity.length || !activity.some((v) => v > 0)) return null;
  const max = Math.max(1, ...activity);
  const bars = activity
    .slice()
    .reverse()
    .map((value) =>
      el('span', {
        className: 'spark-bar',
        title: `${value} commit${value === 1 ? '' : 's'}`,
        style: `height:${Math.max(2, Math.round((value / max) * 24))}px`,
      })
    );
  return el('div', { className: 'insp-spark' }, [
    el('div', { className: 'sparkline' }, bars),
    el('span', { className: 'insp-gloss', textContent: 'commits per month, oldest → newest (24 months)' }),
  ]);
}

/** A horizontal stacked bar: `[{label, value, colour}]`, with a legend under it. */
function shareBar(parts, caption) {
  const total = parts.reduce((sum, p) => sum + (p.value || 0), 0);
  if (!total) return null;
  const bar = el('div', { className: 'insp-bar' });
  const legend = el('div', { className: 'insp-bar-legend' });
  for (const part of parts) {
    if (!part.value) continue;
    const width = (part.value / total) * 100;
    bar.append(el('span', { style: `width:${width.toFixed(2)}%;background:${part.colour}`, title: `${part.label}: ${Math.round(width)}%` }));
    legend.append(el('span', {}, [el('i', { style: `background:${part.colour}` }), `${part.label} ${Math.round(width)}%`]));
  }
  return el('div', { className: 'insp-share' }, [bar, legend, caption ? el('span', { className: 'insp-gloss', textContent: caption }) : null]);
}

const SHARE_COLOURS = ['#b28ad6', '#56b4e9', '#e69f00', '#3ddc84', '#f0e442', '#8a8f99'];

/** Two aligned monthly series, oldest to newest: bars for commits, dots for people. */
function trendChart(commits, people) {
  if (!commits || !commits.some((v) => v > 0)) return null;
  const max = Math.max(1, ...commits);
  const maxPeople = Math.max(1, ...(people || [0]));
  const bars = commits.slice().reverse().map((value, i) => {
    const month = commits.length - 1 - i;
    const who = people && people.length ? people[month] : null;
    const bar = el('span', {
      className: 'spark-bar',
      title: `${value} commit${value === 1 ? '' : 's'}${who !== null ? ` by ${who} ${who === 1 ? 'person' : 'people'}` : ''}, ${month} month${month === 1 ? '' : 's'} ago`,
      style: `height:${Math.max(2, Math.round((value / max) * 24))}px`,
    });
    if (who) bar.append(el('i', { className: 'spark-dot', style: `bottom:${Math.round((who / maxPeople) * 24) + 2}px` }));
    return bar;
  });
  return el('div', { className: 'insp-spark' }, [
    el('div', { className: 'sparkline trend' }, bars),
    el('span', {
      className: 'insp-gloss',
      textContent: people && people.length
        ? 'bars: commits per month; dots: distinct people active that month (oldest → newest)'
        : 'commits per month, oldest → newest (24 months)',
    }),
  ]);
}

/** A row of flyable file links. */
function fileLinks(ids, pathForId, limit = 8) {
  if (!ids || !ids.length) return null;
  const list = el('div', { className: 'insp-links' });
  for (const id of ids.slice(0, limit)) {
    const link = el('button', { type: 'button', className: 'insp-link', textContent: (pathForId && pathForId(id)) || `building ${id}`, title: 'fly there' });
    link.dataset.fly = String(id);
    list.append(link);
  }
  if (ids.length > limit) list.append(el('span', { className: 'insp-gloss', textContent: `+ ${ids.length - limit} more` }));
  return list;
}

/**
 * The badges for every prop standing on or around a building, each with why
 * it is there -- the legend, answered for this one building.
 */
function signsFor(b, flags) {
  const signs = [];
  if (flags.churn && b.topChurn) signs.push(['Crane', 'in the top 10% of recent change: under active construction', 'crane']);
  else if (flags.churn && b.heat > 0) {
    const tier = b.heat > 0.85 ? 'red' : b.heat > 0.65 ? 'amber' : 'grey';
    signs.push([`${tier[0].toUpperCase()}${tier.slice(1)} beacon`, `recent activity above ${pct(b.heat - 0.01)} of changed files`, 'beacon']);
  }
  if (flags.age && b.isNew) signs.push(['Scaffolding', 'first committed in the newest slice of the repository’s life', 'new']);
  if (flags.centrality && b.downtown) signs.push(['Antenna & glass', 'downtown: among the most central 5% of files', 'downtown']);
  if (flags.knowledge && b.knowledgeRisk) signs.push(['Red flag', 'its main author has not committed in six months', 'risk']);
  else if (flags.authorship && b.soleTenant) signs.push(['Corner flag', 'bus factor 1: one author wrote ≥ 90% of it', 'flag']);
  if (flags.hotspots && b.isHotspot) signs.push(['Hazard barriers', `hotspot #${b.hotspotRank}: big and constantly changing`, 'hot']);
  if (b.oversized) signs.push(['Buttresses', 'oversized: top 5% by lines and 400+ lines', 'heavy']);
  if (flags.imports && b.orphan) signs.push(['Boarded up', 'nothing imports it and it has sat still for 6+ months', 'vacant']);
  if (flags.imports && b.cycle) signs.push(['Pennant', `part of an import cycle of ${b.cycleSize} files`, 'cycle']);
  if (flags.layering && b.violations) signs.push(['No-entry sign', `${plural(b.violations, 'import')} against the layering`, 'risk']);
  if (flags.tests && b.untestedRisk) signs.push(['Traffic cones', 'risky and no test is linked to it', 'hot']);
  if (flags.complexity && b.braced) signs.push(['Cross-bracing', `one function has ${b.braceComplexity} decision points`, 'heavy']);
  if (flags.codeowners && b.ownerDrift) signs.push(['Owner notice', 'CODEOWNERS names people who do not write it', 'flag']);
  if (flags.defects && b.isDefect) signs.push(['Warning lamp', `defect-prone: ${pct(b.fixRatio)} of its ${plural(b.commits, 'commit')} are fixes`, 'risk']);
  if (flags.hubs && b.isHub) signs.push(['Steel collar', 'a hub: widely imported and importing widely', 'heavy']);
  if (flags.debt && b.debt && b.debt.length) signs.push(['Yellow tags', `${plural(b.debt.length, 'TODO / FIXME marker')} in its comments`, 'flag']);
  if (flags.trend && b.risingHotspot) signs.push(['Rising hotspot', 'a hotspot that got busier this quarter', 'hot']);
  if (flags.clones && b.cloneOf && b.cloneOf.length) signs.push(['Twin', `shares copied code with ${plural(b.cloneOf.length, 'other file')}`, 'cycle']);
  if (flags.hiddenCoupling && b.hiddenCoupling && b.hiddenCoupling.length) signs.push(['Hidden coupling', `changes with ${plural(b.hiddenCoupling.length, 'file')} in other folders that it never imports`, 'cycle']);
  if (flags.delta && b.delta) signs.push(['Survey stake', `${b.delta} since the baseline${b.locDelta ? ` (${b.locDelta > 0 ? '+' : ''}${b.locDelta} lines)` : ''}`, 'new']);
  return signs;
}

const SIGNAL_NAMES = {
  hotspot: 'hotspots', defect: 'defect-prone', cycle: 'import cycles', violation: 'layering violations',
  untested: 'untested risk', knowledge: 'owner gone', rising: 'rising hotspots', oversized: 'oversized',
  hub: 'hubs', clone: 'copied code', hiddencoupling: 'hidden coupling', orphan: 'possible dead code',
  drift: 'CODEOWNERS drift',
};

/**
 * A folder's health grade (analyzer/grades.py): the letter, the score, which
 * way it moved since the baseline, and which signals cost the points.
 */
export function gradeFact(target) {
  if (!target || !target.grade) return null;
  const badge = el('span', { className: `grade-badge grade-${target.grade}`, textContent: target.grade });
  const moved = target.baselineGrade && target.baselineScore >= 0 ? target.score - target.baselineScore : 0;
  const trend = target.baselineGrade
    ? el('span', {
      className: `grade-trend ${moved > 0.5 ? 'better' : moved < -0.5 ? 'worse' : ''}`,
      textContent: moved > 0.5 ? `▲ from ${target.baselineGrade}` : moved < -0.5 ? `▼ from ${target.baselineGrade}` : `= ${target.baselineGrade} at the baseline`,
    })
    : null;
  const item = el('div', { className: 'insp-fact' }, [
    el('span', { className: 'insp-label', textContent: 'Health grade' }),
    el('span', { className: 'insp-value' }, [badge, ` ${Math.round(target.score)} / 100`, trend]),
    el('span', {
      className: 'insp-gloss',
      textContent: target.gradeWhy && target.gradeWhy.length
        ? 'points lost to each signal, weighted by the square root of each file\'s lines:'
        : 'none of its code carries a health signal',
    }),
  ]);
  if (target.gradeWhy && target.gradeWhy.length) {
    item.append(el('ul', { className: 'grade-why' }, target.gradeWhy.slice(0, 6).map(([signal, points]) =>
      el('li', {}, [el('span', { textContent: SIGNAL_NAMES[signal] || signal }), el('span', { textContent: `−${points}` })])
    )));
  }
  return item;
}

export class Inspector {
  constructor(source) {
    this.source = source;
    this.panel = document.getElementById('inspector');
    this.title = document.getElementById('inspector-title');
    this.pathEl = document.getElementById('inspector-path');
    this.metrics = document.getElementById('inspector-metrics');
    this.floorsEl = document.getElementById('inspector-floors');
    this.hint = document.getElementById('inspector-source-hint');
    this.openDetail = document.getElementById('inspector-open-detail');
    this.selected = null;
    // Set by main.js: building id -> repository path (for cycle members and
    // co-changed files), and a way to fly to a building by id.
    this.pathForId = null;
    this.onFly = null;
    // Also set by main.js: import edges (facets.js::edgeMaps), the reader's
    // notes (notes.js), a way to open another district, and a hook that hears
    // every selection change so the overlay and the focus fade can follow it.
    this.edges = null;
    this.notes = null;
    this.onDistrict = null;
    this.onSelect = null;
    document.getElementById('inspector-close').addEventListener('click', () => this.hide());
    if (this.openDetail) {
      this.openDetail.addEventListener('click', () => this._openDetailWindow());
    }
    this.metrics.addEventListener('click', (event) => {
      const link = event.target.closest('[data-fly]');
      if (link && this.onFly) this.onFly(Number(link.dataset.fly));
      const folder = event.target.closest('[data-district]');
      if (folder && this.onDistrict) this.onDistrict(Number(folder.dataset.district));
    });
    this.metrics.addEventListener('keydown', (event) => event.stopPropagation());
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.hide();
    });
  }

  hide() {
    const was = this.selected;
    this.panel.hidden = true;
    this.selected = null;
    this._floorToken = null;
    if (was && this.onSelect) this.onSelect(null);
  }

  _announce() {
    if (this.onSelect) this.onSelect(this.selected);
  }

  /**
   * Open the detail window for whatever is currently selected.
   *
   * `onOpenDetail`, when set by main.js, takes precedence: a single-file
   * build has no second HTML document to link to (`file://` cannot navigate
   * between two local documents reliably either), so main.js wires this to
   * the same in-page overlay `detail.js` renders for the multi-file case.
   * Otherwise this falls back to a real new-tab navigation to detail.html.
   */
  _openDetailWindow() {
    if (!this.selected || this.selected.kind === 'region') return;
    const id = this.selected.kind === 'building' ? this.selected.building.id : this.selected.district.id;
    if (typeof this.onOpenDetail === 'function') {
      this.onOpenDetail(this.selected.kind, id);
      return;
    }
    const query = this.selected.kind === 'building' ? `?b=${id}` : `?d=${id}`;
    window.open(`detail.html${query}`, '_blank');
  }

  _name(index) {
    const name = index >= 0 ? this.source.s(index) : '';
    return name || (this.source.locked ? '(locked)' : 'unknown');
  }

  showBuilding(building) {
    this.selected = { kind: 'building', building };
    const source = this.source;
    const b = building;
    const flags = source.manifest.flags || {};
    this.panel.hidden = false;
    this.title.textContent = source.label(b) || source.s(b.path);
    this.pathEl.textContent = source.locked ? '(locked)' : source.s(b.path);
    if (this.openDetail) this.openDetail.hidden = false;
    this.metrics.innerHTML = '';
    this.floorsEl.innerHTML = '';

    const isData = b.rows !== null && b.rows !== undefined;
    const language = source.s(b.language);

    // -- What you're looking at ------------------------------------------------
    const signs = signsFor(b, flags);
    const overview = [
      el('p', {
        className: 'insp-lede',
        textContent:
          `${language ? `${language[0].toUpperCase()}${language.slice(1)} file` : 'A file'}, drawn as ` +
          `${FORM_MEANING[b.archetype] || archetypeLabel(b.archetype)}.`,
      }),
    ];
    if (signs.length) {
      overview.push(
        el('ul', { className: 'insp-signs' },
          signs.map(([name, why, kind]) =>
            el('li', { className: `sign-${kind}` }, [el('strong', { textContent: name }), ` — ${why}`])
          ))
      );
    } else {
      overview.push(el('p', { className: 'insp-gloss', textContent: 'No construction or health markers: a quiet, ordinary building.' }));
    }
    this.metrics.append(section('What you’re looking at', overview));

    // -- Reading the structure ----------------------------------------------
    const w = b.width || 0;
    const d = b.depth || 0;
    const floorsFact = fact(
      'Floors',
      isData ? '—' : plural(b.floors, 'floor'),
      isData
        ? 'data files have no floors: a silo holds rows, not definitions'
        : b.floors
          ? `one floor per function, class, heading or cell -- one row of windows each`
          : 'no definitions were found: a single open hall'
    );
    const structure = [
      isData
        ? fact('Height', `${Math.round(b.height || 0)} m`, `${(b.rows || 0).toLocaleString()} rows of data — a silo’s height is its row count`)
        : fact(
            'Height',
            `${Math.round(b.height || 0)} m`,
            `${(b.loc || 0).toLocaleString()} logical lines. Height grows with √lines; blank lines and comments do not count, bytes on disk never do`
          ),
      floorsFact,
      fact(
        'Footprint',
        w && d ? `${w.toFixed(1)} × ${d.toFixed(1)} m · ${Math.round(w * d).toLocaleString()} m²` : formatBytes(b.bytes),
        b.plate !== null && b.plate !== undefined
          ? `≈ ${b.plate} lines per floor. A wide plan means long definitions on average; a slender tower, many short ones`
          : 'no floors to divide, so the plot follows the file’s size'
      ),
      b.lit === null || b.lit === undefined
        ? fact('Windows', 'none', 'data and binary files have no windows to light')
        : fact(
            'Windows',
            `${pct(b.lit)} lit`,
            b.orphan && flags.imports
              ? 'boarded up: the windows are dark because nothing uses this building'
              : `${pct(b.docRatio)} of its lines are documentation. Dark windows = undocumented code`
          ),
    ];
    if (flags.recency) {
      const r = b.recencyDays || 0;
      const state = r < 60 ? 'clean facade' : r < 365 ? 'lightly weathered' : r < 730 ? 'weathered' : 'grimy';
      structure.push(fact('Weathering', state, `last touched ${beforeHead(r)}`));
    }
    if (b.parseConfidence && b.parseConfidence !== 'high') {
      structure.push(fact('Parser', `${b.parseConfidence} confidence`, 'floors come from a heuristic parser for this language: treat names and counts as approximate'));
    }
    this.metrics.append(section('Reading the structure', structure));
    // Floors load asynchronously; the gloss above is upgraded with the names.
    if (b.floors > 0) this._loadFloors(b, floorsFact);

    // -- People -----------------------------------------------------------------
    const people = [];
    if (b.firstAuthor !== undefined && b.firstAuthor >= 0) {
      people.push(fact('Built by', this._name(b.firstAuthor), flags.age || b.ageDays ? `first commit ${beforeHead(b.ageDays)}` : 'author of its first commit'));
    }
    if (b.lastAuthor !== undefined && b.lastAuthor >= 0) {
      const message = b.lastMessage >= 0 ? source.s(b.lastMessage) : '';
      people.push(fact('Last edited by', this._name(b.lastAuthor), `${beforeHead(b.recencyDays)}${message ? ` — “${message}”` : ''}`));
    } else if (b.lastMessage >= 0) {
      people.push(fact('Last commit', source.s(b.lastMessage)));
    }
    if (b.author >= 0) {
      people.push(fact('Main owner', this._name(b.author), `wrote ${pct(b.ownership)} of the lines ever added${flags.authorship ? '' : ' (single-author repository)'}`));
    }
    if (b.authorCount) {
      people.push(fact('Contributors', String(b.authorCount), b.busFactor ? `bus factor ${b.busFactor}: ${plural(b.busFactor, 'person', 'people')} wrote half of it` : ''));
    }
    if (flags.authorship && b.ownerInactive) {
      people.push(fact('Owner status', `away ${humanDays(b.ownerAwayDays)}`, 'the main owner has not committed anywhere in the repository since'));
    }
    if (flags.authorship && b.authorShares && b.authorShares.length > 1) {
      const shares = b.authorShares.map(([name, share], i) => ({ label: this._name(name), value: share, colour: SHARE_COLOURS[i % SHARE_COLOURS.length] }));
      const rest = 1 - b.authorShares.reduce((sum, [, share]) => sum + share, 0);
      if (rest > 0.005) shares.push({ label: 'others', value: rest, colour: SHARE_COLOURS[5] });
      people.push(shareBar(shares, 'share of the lines ever added, by author'));
    }
    if (flags.authorship && b.experts && b.experts.length) {
      people.push(fact(
        'Who to ask',
        b.experts.map(([name]) => this._name(name)).join(', '),
        'ranked by lines written, halved for every six months since they last touched this file'
      ));
    }
    if (flags.codeowners && b.declaredOwners) {
      people.push(fact(
        'CODEOWNERS',
        b.declaredOwners.length ? b.declaredOwners.map((i) => this._name(i)).join(' ') : 'no owner',
        b.ownerDrift
          ? 'drifted: the people named here commit to the repository, but wrote almost none of this file'
          : b.unowned ? 'no CODEOWNERS rule covers this file' : 'declared reviewers for this path'
      ));
    }
    if (people.length) this.metrics.append(section('People', people));

    // -- Activity ---------------------------------------------------------------
    const activity = [fact('Commits', String(b.commits || 0), 'commits that touched this file')];
    if (flags.churn) {
      activity.push(fact('Churn', `${(b.churn || 0).toLocaleString()} lines`, 'added + deleted over its whole history'));
      activity.push(fact('Heat', b.heat ? `${Math.round(b.heat * 100)}th pct` : 'quiet', 'recent, decay-weighted change: a month ago counts half as much as today'));
    }
    if (flags.age) {
      activity.push(fact('Age', humanDays(b.ageDays), `${b.era === 'old' ? 'old town' : b.era === 'new' ? 'new build' : 'middle era'} — ${b.isNew ? 'still under scaffolding' : 'finished'}`));
    }
    if (b.importInDegree) activity.push(fact('Imported by', plural(b.importInDegree, 'file'), 'resolved imports pointing here (best-effort)'));
    if (b.commits && (b.fixCommits || flags.defects)) {
      const item = fact(
        'Fix commits',
        `${b.fixCommits || 0} of ${b.commits} (${pct(b.fixRatio)})`,
        b.isDefect
          ? 'defect-prone: among the top tenth of the repository by share of fixes'
          : 'commits whose subject reads as a fix: fix, bug, hotfix, revert, closes #n'
      );
      const bar = shareBar([
        { label: 'fixes', value: b.fixCommits || 0, colour: '#ff2d55' },
        { label: 'other', value: Math.max(0, b.commits - (b.fixCommits || 0)), colour: '#56657a' },
      ]);
      if (bar) item.append(bar);
      activity.push(item);
    }
    if (flags.trend) {
      const recent = (b.activity || []).slice(0, 3).reduce((a, v) => a + v, 0);
      const before = (b.activity || []).slice(3, 6).reduce((a, v) => a + v, 0);
      activity.push(fact(
        'Trend',
        b.trend > 0 ? 'rising' : b.trend < 0 ? 'cooling' : 'steady',
        `${plural(recent, 'commit')} in the last three months, ${before} in the three before` +
          (b.risingHotspot ? ' — a rising hotspot: refactor before it gets dearer' : '')
      ));
    }
    const spark = flags.churn || flags.trend ? sparkline(b.activity) : null;
    this.metrics.append(section('Activity', [...activity, spark], false));

    // -- Structure: imports, layering, tests ---------------------------------------
    const structureFacts = this._structure(b, flags);
    if (structureFacts.length) this.metrics.append(section('Structure', structureFacts, false));

    // -- Written-down debt ------------------------------------------------------------
    if (b.debt && b.debt.length) {
      const rows = b.debt.map(([line, marker, text]) => {
        const said = source.locked || text < 0 ? '' : source.s(text);
        return el('li', {}, [
          el('code', { textContent: `${marker}` }),
          ` line ${line}`,
          said ? el('span', { className: 'insp-gloss', textContent: ` — ${said}` }) : null,
        ]);
      });
      this.metrics.append(section(`Debt markers (${b.debt.length})`, [el('ul', { className: 'insp-notes' }, rows)], false));
    }

    // -- Since the baseline ---------------------------------------------------------
    const delta = source.manifest.delta;
    if (flags.delta && delta) {
      const since = this._baselineLabel(delta);
      const change = b.delta === 'added'
        ? 'new since then'
        : b.locDelta
          ? `${b.locDelta > 0 ? '+' : ''}${b.locDelta.toLocaleString()} logical lines${b.delta ? ` (${b.delta})` : ''}`
          : 'unchanged in size';
      const items = [fact('Change', change, `against ${since}`)];
      if (b.became && b.became.length) items.push(fact('Newly flagged', b.became.join(', '), 'signals this file did not carry at the baseline'));
      this.metrics.append(section('Since the baseline', items, Boolean(b.delta || (b.became && b.became.length))));
    }

    // -- Architect's notes --------------------------------------------------------
    const notes = this._notes(b, flags);
    const notesSection = section('Architect’s notes', notes.length
      ? [el('ul', { className: 'insp-notes' }, notes)]
      : [el('p', { className: 'insp-gloss', textContent: 'Nothing flagged. Its size, change rate, ownership and imports are unremarkable for this repository.' })]);
    notesSection.classList.add('insp-architect');
    this.metrics.append(notesSection);
    if (flags.coupling) this._loadCoupling(b, notesSection);
    this._noteEditor(b);

    this.hint.textContent = b.source
      ? 'Press E (in walk mode, standing outside) to read its source on the walls.'
      : b.isBinary
        ? 'Binary artefact — no source to show.'
        : '';
    this._announce();
  }

  _baselineLabel(delta) {
    const base = delta.baseline || {};
    const label = base.label >= 0 ? this.source.s(base.label) : '';
    if (label) return label;
    if (base.head) return `the build of ${base.head.slice(0, 7)}`;
    return 'the previous build';
  }

  /** Imports, importers, instability, layering and tests: the building's place in the design. */
  _structure(b, flags) {
    const items = [];
    const edges = this.edges;
    if (flags.imports) {
      const out = edges ? edges.imports.get(b.id) || [] : [];
      const inbound = edges ? edges.importers.get(b.id) || [] : [];
      const inst = b.instability;
      items.push(fact(
        'Imports',
        `${plural(b.importsOut || out.length, 'file')} out · ${plural(b.importInDegree || inbound.length, 'file')} in`,
        'select to see them as utility lines: blue out, amber in'
      ));
      if (inst !== undefined && inst >= 0) {
        items.push(fact(
          'Instability',
          inst.toFixed(2),
          inst < 0.25
            ? 'a foundation: many files lean on it and it leans on few. Change it rarely and carefully'
            : inst > 0.75
              ? 'a leaf: it depends on others and little depends on it. Free to change'
              : 'balanced between depending and being depended on'
        ));
      }
      if (flags.layering && b.violations && edges) {
        const bad = out.filter((to) => edges.violating.has(`${b.id}>${to}`));
        const item = fact('Layering', `${plural(b.violations, 'import')} against the grain`, 'red lines: imports that break the layering rule');
        const links = fileLinks(bad, this.pathForId);
        if (links) item.append(links);
        items.push(item);
      }
      if (inbound.length) {
        const item = fact('Imported by', plural(inbound.length, 'file'));
        const links = fileLinks(inbound, this.pathForId, 6);
        if (links) item.append(links);
        items.push(item);
      }
    }
    if (flags.tests && (b.untested || (b.testedBy && b.testedBy.length))) {
      const tested = b.testedBy && b.testedBy.length;
      const item = fact(
        'Tests',
        tested ? plural(b.testedBy.length, 'linked test') : 'none linked',
        tested ? 'tests that import it or are named after it' : b.untestedRisk ? 'risky and untested: the traffic cones' : 'no test imports it or is named after it'
      );
      const links = tested ? fileLinks(b.testedBy, this.pathForId, 5) : null;
      if (links) item.append(links);
      items.push(item);
    }
    if (flags.imports && b.importDepth) {
      items.push(fact(
        'Import depth',
        plural(b.importDepth, 'level'),
        b.importDepth >= 5
          ? 'a long chain below it: a change at the bottom travels a long way up to here'
          : 'the longest chain of imports below it, cycles counted once'
      ));
    }
    if (b.isHub) {
      items.push(fact('Hub', 'yes', 'top tenth both for importers and for imports: split it along its callers'));
    }
    if (b.hiddenCoupling && b.hiddenCoupling.length) {
      const item = fact(
        'Hidden coupling',
        plural(b.hiddenCoupling.length, 'file'),
        'changes in the same commits, in another folder, with no import either way: dashed violet arcs'
      );
      const links = fileLinks(b.hiddenCoupling.map(([id]) => id), this.pathForId, 6);
      if (links) item.append(links);
      items.push(item);
    }
    if (b.cloneOf && b.cloneOf.length) {
      const item = fact(
        'Copied code',
        b.cloneOf.map(([, ratio]) => pct(ratio)).join(', ') + ' shared',
        'files with a long near-identical block: a fix in one is easily missed in the other'
      );
      const links = fileLinks(b.cloneOf.map(([id]) => id), this.pathForId, 6);
      if (links) item.append(links);
      items.push(item);
    }
    if (b.classes) {
      items.push(fact('Types', `${b.classes} defined · ${b.abstractClasses || 0} abstract`, 'classes, interfaces, traits and protocols in this file'));
    }
    if (b.braceComplexity) {
      items.push(fact('Most branches', `${b.braceComplexity} decision points`, b.braced ? 'in one function: braced, 15 or more' : 'in its busiest function'));
    }
    return items;
  }

  /** The reader's own note on this building (localStorage; see notes.js). */
  _noteEditor(b) {
    const notes = this.notes;
    const path = this.source.locked ? '' : this.source.s(b.path);
    if (!notes) return;
    const body = [];
    if (!notes.available) {
      body.push(el('p', { className: 'insp-gloss', textContent: 'Notes need browser storage, which is unavailable here.' }));
    } else if (!path) {
      body.push(el('p', { className: 'insp-gloss', textContent: 'Unlock the city to read and write notes.' }));
    } else {
      const area = el('textarea', { className: 'insp-note', rows: 3, placeholder: 'A note for yourself: kept in this browser, pinned on the map.', value: notes.get(path) });
      const save = el('button', { type: 'button', className: 'chip-btn', textContent: 'Save note' });
      const status = el('span', { className: 'insp-gloss' });
      save.addEventListener('click', () => {
        const ok = notes.set(path, area.value);
        status.textContent = ok ? (area.value.trim() ? 'saved' : 'removed') : 'could not save';
      });
      body.push(area, el('div', { className: 'insp-note-actions' }, [save, status]));
    }
    this.metrics.append(section('Your note', body, Boolean(path && notes.get(path))));
  }

  /** Rule-based, self-explaining suggestions: each says what fired and why. */
  _notes(b, flags) {
    const notes = [];
    const note = (level, title, body) =>
      notes.push(el('li', { className: `note-${level}` }, [el('strong', { textContent: title }), ` ${body}`]));
    const longest = b.longestFloor && b.longestFloor.name >= 0
      ? { name: this.source.s(b.longestFloor.name) || '(locked)', loc: b.longestFloor.loc }
      : null;

    if (flags.hotspots && b.isHotspot) {
      const sizePct = b.sizePct || 0;
      const commitPct = sizePct ? Math.min(1, (b.hotspot || 0) / sizePct) : 0;
      note('high', `Hotspot #${b.hotspotRank}.`,
        `Changed more often than ${pct(commitPct)} of files and larger than ${pct(sizePct)}. ` +
        'Every change here costs the most: the first place a refactor pays back.');
    }
    if (b.oversized) {
      note('high', 'Oversized.',
        `${(b.loc || 0).toLocaleString()} logical lines, larger than ${pct(b.sizePct)} of the code files.` +
        (longest ? ` Start by splitting out \`${longest.name}\` (${longest.loc} lines).` : ' Split it along its floors.'));
    } else if (longest && longest.loc >= 80) {
      note('mid', 'Long definition.', `\`${longest.name}\` is ${longest.loc} lines. Extracting parts of it would make it easier to read and test.`);
    }
    if ((b.maxComplexity || 0) >= 15) {
      note('mid', 'Branch-heavy.', `One definition has ${b.maxComplexity} decision points (if/for/while/try…). Hard to test exhaustively.`);
    }
    if (flags.imports && b.cycle) {
      const members = this._cycleMembers(b);
      const item = el('li', { className: 'note-high' }, [
        el('strong', { textContent: 'Import cycle.' }),
        ` One of ${b.cycleSize} files that import each other in a loop. None of them can be understood, tested or reused alone. Break one edge:`,
      ]);
      if (members.length) {
        const list = el('div', { className: 'insp-links' });
        for (const id of members) {
          if (id === b.id) continue;
          list.append(el('button', {
            type: 'button',
            className: 'insp-link',
            textContent: (this.pathForId && this.pathForId(id)) || `building ${id}`,
            title: 'fly there',
          }));
          list.lastChild.dataset.fly = String(id);
        }
        item.append(list);
      }
      notes.push(item);
    }
    if (flags.knowledge && b.knowledgeRisk) {
      note('high', 'Knowledge risk.',
        `${this._name(b.author)} wrote ${pct(b.ownership)} of it and has been away ${humanDays(b.ownerAwayDays)}. ` +
        'Whoever changes it next is on their own. Document it or pair on the next change.');
    } else if (flags.authorship && b.soleTenant) {
      note('mid', 'Bus factor 1.', `${this._name(b.author)} wrote ${pct(b.ownership)} of it. Have someone else review the next change so the knowledge spreads.`);
    }
    if (flags.imports && b.orphan) {
      note('mid', 'Possibly dead code.',
        `Nothing in the repository imports it, it is not an entry point, and it has not changed in ${humanDays(b.recencyDays)}. ` +
        'Import resolution is best-effort, so check for dynamic loading before deleting.');
    }
    if (b.lit !== null && b.lit !== undefined && (b.docRatio || 0) < 0.05 && (b.loc || 0) >= 150 && !b.isTest) {
      note('low', 'Undocumented.', `Only ${pct(b.docRatio)} of ${(b.loc || 0).toLocaleString()} lines are comments or docstrings: the facade is dark.`);
    }
    if (flags.layering && b.violations) {
      const rules = this.source.manifest.dependencies;
      const byFile = rules && rules.rules >= 0 && this.source.s(rules.rules) !== 'majority';
      note('high', 'Layering violation.',
        byFile
          ? `${plural(b.violations, 'import')} break the rules in ${this.source.s(rules.rules)}. Invert the dependency or move the shared code down a layer.`
          : `${plural(b.violations, 'import')} run against the main direction between two folders, closing a folder-level cycle. Cutting these edges untangles the folders.`);
    }
    if (flags.tests && b.untestedRisk) {
      const why = [b.isHotspot && 'a hotspot', b.oversized && 'oversized', b.downtown && 'downtown'].filter(Boolean).join(', ');
      note('high', 'Untested and risky.', `It is ${why}, and no test imports it or is named after it. A characterisation test before the next change is cheap insurance.`);
    }
    if (flags.codeowners && b.ownerDrift) {
      note('mid', 'CODEOWNERS has drifted.', `Reviews go to ${(b.declaredOwners || []).map((i) => this._name(i)).join(' ')}, but ${this._name(b.author)} wrote ${pct(b.ownership)} of it. Update CODEOWNERS or pair the two.`);
    }
    if (flags.delta && b.became && b.became.length) {
      note('mid', 'New since the baseline.', `It became ${b.became.join(', ')} since ${this._baselineLabel(this.source.manifest.delta || {})}.`);
    }
    if (flags.centrality && b.downtown && (b.loc || 0) > 300) {
      note('low', 'Central and large.', 'Many files depend on or change with this one. Keep its interface small and stable.');
    }
    return notes;
  }

  _cycleMembers(b) {
    const review = this.source.manifest.review;
    if (!review || !review.cycles) return [];
    const cycle = review.cycles.find((members) => members.includes(b.id));
    return cycle || [];
  }

  async _loadCoupling(b, container) {
    try {
      const bridges = await this.source.bridges();
      if (this.selected === null || this.selected.building !== b) return;
      const related = bridges.filter(([x, y]) => x === b.id || y === b.id).slice(0, 4);
      if (!related.length) return;
      const list = el('div', { className: 'insp-links' });
      let crossing = 0;
      for (const [x, y, count] of related) {
        const other = x === b.id ? y : x;
        const path = (this.pathForId && this.pathForId(other)) || `building ${other}`;
        const link = el('button', { type: 'button', className: 'insp-link', textContent: `${path} · ${count}×`, title: 'fly there' });
        link.dataset.fly = String(other);
        const otherDistrict = this.districtForId && this.districtForId(other);
        if (otherDistrict !== undefined && otherDistrict !== null && otherDistrict !== b.district) {
          link.classList.add('crossing');
          crossing++;
        }
        list.append(link);
      }
      const item = el('li', { className: crossing ? 'note-mid' : 'note-low' }, [
        el('strong', { textContent: 'Changes together with' }),
        crossing
          ? ` these files, ${crossing} of them in another district: hidden coupling across a folder boundary.`
          : ' these files, all in its own district.',
        list,
      ]);
      let ul = container.querySelector('.insp-notes');
      if (!ul) {
        const empty = container.querySelector('.insp-gloss');
        if (empty) empty.remove();
        ul = el('ul', { className: 'insp-notes' });
        container.append(ul);
      }
      ul.append(item);
    } catch (error) {
      // Coupling is a nice-to-have in the inspector; the detail report has it.
    }
  }

  async _loadFloors(building, floorsFact) {
    const heading = el('h2', { textContent: 'Floors, ground to roof' });
    this.floorsEl.append(heading);
    // A newer selection -- even of the same building -- owns the list now.
    const token = (this._floorToken = {});
    try {
      const detail = await this.source.detail(building);
      if (this._floorToken !== token) return;
      const source = this.source;
      const floors = detail.floors || [];
      const top = floors.filter((f) => !f.depth);
      // Upgrade the floors gloss with the actual names.
      if (floorsFact && top.length) {
        const kinds = {};
        for (const f of top) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
        const breakdown = Object.entries(kinds).map(([k, n]) => plural(n, k)).join(', ');
        const names = top.slice(0, 3).map((f) => source.s(f.name) || '(anonymous)');
        const nested = floors.length - top.length;
        const gloss = floorsFact.querySelector('.insp-gloss');
        if (gloss) {
          gloss.textContent =
            `${plural(floors.length, 'floor')} = ${breakdown} at the top level` +
            `${nested ? ` + ${plural(nested, 'nested definition')} inside them` : ''} ` +
            `(${names.join(', ')}${top.length > 3 ? ', …' : ''}). One row of windows per floor.`;
        }
      }
      // Floor sizes at a glance: one bar per top-level floor, ground to roof,
      // so one enormous definition among small ones is visible before reading.
      if (top.length > 1) {
        const max = Math.max(1, ...top.map((f) => f.loc || 0));
        const chart = el('div', { className: 'floor-chart', title: 'logical lines per top-level floor, ground floor first' });
        for (const f of top.slice(0, 80)) {
          chart.append(el('span', {
            className: (f.complexity || 0) >= 15 ? 'hot' : '',
            title: `${source.s(f.name) || '(anonymous)'}: ${f.loc} lines${f.complexity ? `, ${f.complexity} decision points` : ''}`,
            style: `height:${Math.max(2, Math.round(((f.loc || 0) / max) * 30))}px`,
          }));
        }
        this.floorsEl.append(chart);
      }
      for (const floor of floors) {
        const row = el('div', { className: 'floor' });
        const name = el('span', {
          className: 'name',
          textContent: '  '.repeat(Math.min(floor.depth || 0, 4)) + (source.s(floor.name) || '(anonymous)') + (floor.isEntrypoint ? ' ★' : ''),
        });
        const meta = [floor.kind, floor.loc ? `${floor.loc} ln` : '', floor.complexity >= 10 ? `cx ${floor.complexity}` : '']
          .filter(Boolean)
          .join(' · ');
        row.append(name, el('span', { className: 'kind', textContent: meta }));
        this.floorsEl.append(row);
      }
      if (!floors.length) {
        this.floorsEl.append(el('p', { className: 'hint', textContent: 'No top-level symbols were found in this file.' }));
      }
    } catch (error) {
      if (this._floorToken !== token) return;
      this.floorsEl.append(el('p', { className: 'hint', textContent: `Could not load floors: ${error.message}` }));
    }
  }

  /** Folder health, summed over whichever districts are passed in. */
  _healthFacts(districts, flags) {
    const sum = (key) => districts.reduce((total, d) => total + (d[key] || 0), 0);
    const facts = [];
    if (flags.hotspots) facts.push(fact('Hotspots', String(sum('hotspots')), 'files that are both large and constantly changing'));
    facts.push(fact('Oversized', String(sum('oversized')), 'files in the top 5% by lines'));
    if (flags.imports) {
      facts.push(fact('In import cycles', String(sum('cycles')), 'distinct cycles with a member here'));
      facts.push(fact('Possible dead code', String(sum('orphans')), 'not imported, untouched 6+ months'));
    }
    if (flags.knowledge) facts.push(fact('Owner gone', String(sum('knowledgeRisks')), 'files whose main author left 6+ months ago'));
    return facts;
  }

  showDistrict(district) {
    this.selected = { kind: 'district', district };
    this._floorToken = null;
    const source = this.source;
    const flags = source.manifest.flags || {};
    this.panel.hidden = false;
    this.title.textContent = source.districtLabel(district);
    // A breadcrumb of ancestor folder names: the plinths this block stands on.
    this.pathEl.textContent = source.locked
      ? '(locked)'
      : (district.pathSegments || []).map((i) => source.s(i)).join(' / ') || source.s(district.key);
    if (this.openDetail) this.openDetail.hidden = false;
    this.metrics.innerHTML = '';
    this.floorsEl.innerHTML = '';

    const level = district.level || 0;
    const overview = [
      el('p', {
        className: 'insp-lede',
        textContent:
          `A district: one folder’s own files${level ? `, on a plinth ${level} level${level === 1 ? '' : 's'} up (nested ${level} folder${level === 1 ? '' : 's'} deep)` : ', at street level'}. ` +
          'Its ground is sized by how much code it holds.',
      }),
      fact('Buildings', String(district.buildings), `${district.testFiles} tests (parks) · ${district.dataFiles} data files (silos)`),
      fact('Logical lines', (district.logicalLoc || 0).toLocaleString()),
      fact('Documented', `${district.documented} of ${district.buildings}`, 'files where at least 10% of lines are documentation'),
      fact('Language', source.s(district.primaryLanguage)),
      fact('Tallest', `${Math.round(district.skyline.maxHeight)} m`),
      fact('Town hall', district.hasReadme ? source.s(district.readmeRel) : 'none', district.hasReadme ? 'the README that explains this folder' : 'no README: nothing explains this folder to a newcomer'),
    ];
    this.metrics.append(section('What you’re looking at', overview));

    const people = [];
    if (flags.authorship) people.push(fact('Mayor', source.s(district.mayor) || 'unknown', 'the author with the most lines in this district'));
    if (district.contributors !== undefined) {
      people.push(fact('Contributors', String(district.contributors), district.busFactor ? `bus factor ${district.busFactor}: ${plural(district.busFactor, 'person', 'people')} wrote half of it` : ''));
    }
    if (flags.authorship && district.experts && district.experts.length) {
      people.push(fact('Who to ask', district.experts.map((e) => this._name(e.name)).join(', '), 'recency-weighted authorship across its files'));
    }
    if (flags.codeowners) {
      people.push(fact('CODEOWNERS', `${district.ownerDrift || 0} drifted · ${district.unowned || 0} unowned`, 'files whose declared owners do not write them / that no rule covers'));
    }
    if (flags.teams && district.recentAuthors !== undefined) {
      people.push(fact(
        'Coordination',
        `${plural(district.recentAuthors, 'person', 'people')} in 3 months · ${pct(district.crossShare)} of commits cross folders`,
        district.manyCooks
          ? `many cooks: nobody leads it (top expert ${pct(district.topShare)}). Name an owner`
          : `leading expert holds ${pct(district.topShare)} of its recency-weighted authorship`
      ));
    }
    if (people.length) this.metrics.append(section('People', people));
    const health = this._healthFacts([district], flags);
    const graded = gradeFact(district);
    if (graded) health.unshift(graded);
    if (flags.churn) health.unshift(fact('Heat', district.heat ? `${Math.round(district.heat * 100)}%` : 'quiet', 'mean recent activity of its files; the pavement warms with it'));
    if (flags.tests && district.sourceFiles) {
      health.push(fact('Tested', `${district.testedFiles} of ${district.sourceFiles}`, `source files with a linked test${district.untestedRisk ? ` · ${district.untestedRisk} risky ones without` : ''}`));
    }
    if (flags.complexity) health.push(fact('Braced', String(district.braced || 0), 'files with a function of 15+ decision points'));
    if (flags.defects) health.push(fact('Defect-prone', String(district.defects || 0), 'files whose commits are unusually often fixes'));
    if (flags.trend && district.rising) health.push(fact('Rising hotspots', String(district.rising), 'hotspots that got busier this quarter'));
    if (flags.hubs && district.hubs) health.push(fact('Hubs', String(district.hubs), 'widely imported and importing widely'));
    if (flags.clones && district.clones) health.push(fact('Copied code', String(district.clones), 'files with a clone twin somewhere'));
    if (flags.debt && district.debt) health.push(fact('Debt markers', String(district.debt), 'TODO / FIXME / HACK comments in its files'));
    this.metrics.append(section('Health', health));
    const structure = this._districtStructure(district, flags);
    if (structure.length) this.metrics.append(section('Structure', structure));
    const trend = flags.churn ? trendChart(district.activity, district.activeAuthors) : null;
    if (trend) this.metrics.append(section('Activity', [trend], false));
    if (flags.delta && source.manifest.delta) {
      this.metrics.append(section('Since the baseline', [fact('Changed files', String(district.changed || 0), `added, grown or shrunk since ${this._baselineLabel(source.manifest.delta)}`)], false));
    }
    this.hint.textContent = 'Click a building to inspect it individually. Arcs show which folders this one depends on and changes with.';
    this._announce();
  }

  /** A folder's afferent/efferent coupling and the folders on either side of it. */
  _districtStructure(district, flags) {
    const manifest = this.source.manifest;
    const deps = manifest.dependencies;
    const items = [];
    if (!flags.imports || !deps) return items;
    const inst = district.instability;
    items.push(fact(
      'Coupling',
      `Ca ${district.ca} · Ce ${district.ce}`,
      'Ca: files elsewhere that import something here. Ce: files here that import something elsewhere'
    ));
    if (inst !== undefined && inst >= 0) {
      items.push(fact('Instability', inst.toFixed(2), inst < 0.25 ? 'a foundation the rest of the code stands on' : inst > 0.75 ? 'a leaf: free to change, nothing leans on it' : 'both depends and is depended on'));
    }
    if (flags.layering && district.violations) {
      items.push(fact('Layering', `${plural(district.violations, 'import')} against the grain`, 'red arcs'));
    }
    if (district.abstractness !== undefined && district.abstractness >= 0) {
      const zone = district.zone === 'pain'
        ? 'zone of pain: stable and concrete. Everything leans on it and nothing in it bends; add interfaces before it hardens further'
        : district.zone === 'uselessness'
          ? 'zone of uselessness: abstract, and nothing depends on it. Is it still needed?'
          : district.distance >= 0 && district.distance > 0.5
            ? 'far from the main sequence: either more abstract than its dependants need, or more concrete'
            : 'close to the main sequence: its abstraction matches how much is built on it';
      items.push(fact(
        'Main sequence',
        `A ${district.abstractness.toFixed(2)}${district.distance >= 0 ? ` · D ${district.distance.toFixed(2)}` : ''}`,
        `${district.abstractClasses} of ${district.classes} types abstract. ${zone}`
      ));
    }
    const name = (id) => {
      const d = manifest.districts[id];
      return d ? this.source.districtLabel(d) : `district ${id}`;
    };
    const folderLinks = (rows, label, gloss) => {
      if (!rows.length) return;
      const item = fact(label, plural(rows.length, 'folder'), gloss);
      const list = el('div', { className: 'insp-links' });
      for (const [id, count] of rows.slice(0, 8)) {
        const link = el('button', { type: 'button', className: 'insp-link', textContent: `${name(id)} · ${count}`, title: 'inspect that folder' });
        link.dataset.district = String(id);
        list.append(link);
      }
      item.append(list);
      items.push(item);
    };
    folderLinks(deps.matrix.filter((r) => r[0] === district.id).map((r) => [r[1], r[2]]), 'Depends on', 'imports from these folders (blue arcs)');
    folderLinks(deps.matrix.filter((r) => r[1] === district.id).map((r) => [r[0], r[2]]), 'Depended on by', 'these folders import from it (amber arcs)');
    folderLinks(
      (deps.coupling || []).filter((r) => r[0] === district.id || r[1] === district.id).map((r) => [r[0] === district.id ? r[1] : r[0], r[3]]),
      'Changes with',
      'shared commits with these folders, with no import to explain it (teal arcs)'
    );
    return items;
  }

  /** A folder that splits into several neighbourhoods: its plinth. */
  showRegion(region) {
    this.selected = { kind: 'region', region };
    this._floorToken = null;
    const source = this.source;
    const manifest = source.manifest;
    const flags = manifest.flags || {};
    const regions = manifest.regions || [];
    this.panel.hidden = false;
    this.title.textContent = `${source.regionLabel(region)}/`;
    this.pathEl.textContent = source.locked ? '(locked)' : source.s(region.key);
    if (this.openDetail) this.openDetail.hidden = true;
    this.metrics.innerHTML = '';
    this.floorsEl.innerHTML = '';

    // Districts under this region: walk each district's region chain upward.
    const byKey = new Map(regions.map((r) => [r.key, r]));
    const inside = (districtRegionKey) => {
      let current = byKey.get(districtRegionKey);
      while (current) {
        if (current.id === region.id) return true;
        current = current.parent >= 0 ? regions[current.parent] : null;
      }
      return false;
    };
    const districts = (manifest.districts || []).filter((d) => d.region >= 0 && inside(d.region));
    const children = regions.filter((r) => r.parent === region.id);

    const overview = [
      el('p', {
        className: 'insp-lede',
        textContent:
          `A folder that splits into ${plural(children.length + districts.filter((d) => d.region === region.key).length, 'neighbourhood')}, ` +
          `raised on a level-${region.level} plinth. The roads inside it are ${['highways', 'avenues', 'streets', 'alleys'][Math.min(3, region.level)]}: ` +
          'the deeper the folder, the narrower its roads.',
      }),
      fact('Buildings', (region.buildings || 0).toLocaleString(), `in ${plural(region.districts, 'district')}`),
      fact('Logical lines', (region.logicalLoc || 0).toLocaleString()),
    ];
    if (children.length) {
      overview.push(fact('Sub-folders', children.map((c) => source.regionLabel(c)).join(', '), 'each on its own, higher plinth'));
    }
    this.metrics.append(section('What you’re looking at', overview));
    this.metrics.append(section('Health', [gradeFact(region), ...this._healthFacts(districts, flags)]));
    this.hint.textContent = 'Click a block inside it to inspect one district. Everything outside this folder is dimmed.';
    this.selected.districtIds = districts.map((d) => d.id);
    this._announce();
  }
}
