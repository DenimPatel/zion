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
  return signs;
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
    document.getElementById('inspector-close').addEventListener('click', () => this.hide());
    if (this.openDetail) {
      this.openDetail.addEventListener('click', () => this._openDetailWindow());
    }
    this.metrics.addEventListener('click', (event) => {
      const link = event.target.closest('[data-fly]');
      if (link && this.onFly) this.onFly(Number(link.dataset.fly));
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.hide();
    });
  }

  hide() {
    this.panel.hidden = true;
    this.selected = null;
    this._floorToken = null;
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
    const spark = flags.churn ? sparkline(b.activity) : null;
    this.metrics.append(section('Activity', [...activity, spark], false));

    // -- Architect's notes --------------------------------------------------------
    const notes = this._notes(b, flags);
    const notesSection = section('Architect’s notes', notes.length
      ? [el('ul', { className: 'insp-notes' }, notes)]
      : [el('p', { className: 'insp-gloss', textContent: 'Nothing flagged. Its size, change rate, ownership and imports are unremarkable for this repository.' })]);
    notesSection.classList.add('insp-architect');
    this.metrics.append(notesSection);
    if (flags.coupling) this._loadCoupling(b, notesSection);

    this.hint.textContent = b.source
      ? 'Press E (in walk mode, standing outside) to read its source on the walls.'
      : b.isBinary
        ? 'Binary artefact — no source to show.'
        : '';
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
    if (people.length) this.metrics.append(section('People', people));
    const health = this._healthFacts([district], flags);
    if (flags.churn) health.unshift(fact('Heat', district.heat ? `${Math.round(district.heat * 100)}%` : 'quiet', 'mean recent activity of its files; the pavement warms with it'));
    this.metrics.append(section('Health', health));
    this.hint.textContent = 'Click a building to inspect it individually.';
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
    this.metrics.append(section('Health', this._healthFacts(districts, flags)));
    this.hint.textContent = 'Click a block inside it to inspect one district.';
  }
}
