/**
 * Slicing the whole city by a text query, without fetching every district.
 *
 * `index.json` is a compact row per building (see loader.js::CitySource.index),
 * columns named by `manifest.indexColumns` so this module never hardcodes
 * positions. A query like `ext:py -is:test loc>50` is parsed into a list of
 * clauses ANDed together; each clause reads one column, resolving language and
 * name through the (possibly locked) string table and extension through the
 * always-plaintext extension table.
 */

// Bit positions must match analyzer/emit.py's FLAG_* constants exactly --
// this is the one place that correspondence has to be kept by hand.
const FLAG_BITS = {
  test: 1 << 0,
  doc: 1 << 1,
  binary: 1 << 2,
  ruin: 1 << 3,
  data: 1 << 4,
  hot: 1 << 5, // topChurn
  new: 1 << 6,
  downtown: 1 << 7,
  soletenant: 1 << 8,
  hotspot: 1 << 9,
  oversized: 1 << 10,
  orphan: 1 << 11,
  cycle: 1 << 12,
  knowledge: 1 << 13,
  violation: 1 << 14,
  untested: 1 << 15,
  untestedrisk: 1 << 16,
  drift: 1 << 17,
  added: 1 << 18,
  grown: 1 << 19,
  shrunk: 1 << 20,
  braced: 1 << 21,
  unowned: 1 << 22,
};

// Numeric comparisons: `loc>500`, `cx>=15`, `fanin>10`. The key is the query
// word, the value the index.json column it reads.
const NUMERIC = { loc: 'loc', age: 'age', heat: 'heat', cx: 'cx', complexity: 'cx', fanin: 'fanin', fanout: 'fanout', delta: 'delta' };

/** Column-index lookup built once from the manifest's declared column order. */
export function columnIndex(indexColumns) {
  const lookup = {};
  (indexColumns || []).forEach((name, i) => {
    lookup[name] = i;
  });
  return lookup;
}

function splitTerms(text) {
  // Quoted terms keep spaces; everything else splits on whitespace.
  const terms = [];
  const re = /"([^"]*)"|(\S+)/g;
  let match;
  while ((match = re.exec(text))) {
    terms.push(match[1] !== undefined ? match[1] : match[2]);
  }
  return terms;
}

/**
 * Parse one query term into a predicate over an index row.
 *
 * `context` supplies the lookups a clause needs: `col` (column index by
 * name), `resolveString(idx)` (strings.bin, may return '' while locked),
 * `resolveExt(idx)` (the plaintext extension table).
 */
function compileTerm(term, context) {
  let negate = false;
  let body = term;
  if (body.startsWith('-') && body.length > 1) {
    negate = true;
    body = body.slice(1);
  }

  let predicate;
  const colonAt = body.indexOf(':');
  const cmpMatch = body.match(/^([a-z]+)(>=|<=|>|<|=)(-?[\d.]+)$/i);

  if (cmpMatch && NUMERIC[cmpMatch[1].toLowerCase()]) {
    const [, field, op, valueText] = cmpMatch;
    const value = Number(valueText);
    const idx = context.col[NUMERIC[field.toLowerCase()]];
    predicate = (row) => {
      if (idx === undefined) return false;
      const cell = Number(row[idx]) || 0;
      switch (op) {
        case '>': return cell > value;
        case '<': return cell < value;
        case '>=': return cell >= value;
        case '<=': return cell <= value;
        default: return cell === value;
      }
    };
  } else if (colonAt > 0) {
    const key = body.slice(0, colonAt).toLowerCase();
    const value = body.slice(colonAt + 1).toLowerCase();
    if (key === 'is') {
      const bit = FLAG_BITS[value];
      const flagsIdx = context.col.flags;
      predicate = (row) => bit !== undefined && flagsIdx !== undefined && (row[flagsIdx] & bit) !== 0;
    } else if (key === 'ext') {
      const idx = context.col.ext;
      const needle = value.startsWith('.') ? value : `.${value}`;
      predicate = (row) => idx !== undefined && context.resolveExt(row[idx]).toLowerCase() === needle;
    } else if (key === 'lang') {
      const idx = context.col.language;
      predicate = (row) => idx !== undefined && context.resolveString(row[idx]).toLowerCase() === value;
    } else if (key === 'name') {
      const idx = context.col.name;
      predicate = (row) => idx !== undefined && context.resolveString(row[idx]).toLowerCase() === value;
    } else if (key === 'path') {
      // path: supports a trailing `**` as a prefix wildcard, matched against
      // the full relative path column (falls back to the name column on an
      // older index.json that predates it).
      const idx = context.col.path !== undefined ? context.col.path : context.col.name;
      const prefix = value.replace(/\*+$/, '');
      predicate = (row) => idx !== undefined && context.resolveString(row[idx]).toLowerCase().startsWith(prefix);
    } else if (key === 'archetype') {
      const idx = context.col.archetype;
      predicate = (row) => idx !== undefined && String(row[idx]).toLowerCase() === value;
    } else if (key === 'owner' || key === 'author') {
      // The main author, by name; a substring so `owner:ada` finds "Ada Lovelace".
      const idx = context.col.owner;
      predicate = (row) => idx !== undefined && row[idx] >= 0 && context.resolveString(row[idx]).toLowerCase().includes(value);
    } else if (key === 'district' || key === 'folder') {
      const idx = context.col.district;
      const prefix = value.replace(/\*+$/, '').replace(/\/$/, '');
      predicate = (row) => {
        if (idx === undefined || !context.resolveDistrict) return false;
        const name = context.resolveDistrict(row[idx]).toLowerCase();
        return name === prefix || name.startsWith(`${prefix}/`);
      };
    } else if (key === 'imports' || key === 'importedby') {
      // `imports:analyzer/health.py` -- files that import a path (prefix);
      // `importedby:zion.py` -- files that path imports. Needs imports.json.
      predicate = edgePredicate(key, value, context);
    } else {
      predicate = () => false;
    }
  } else if (body) {
    // A bare word matches the test/doc/binary/etc. shorthand, or falls back to
    // a case-insensitive substring match on the (resolved) file name.
    const bit = FLAG_BITS[body.toLowerCase()];
    const flagsIdx = context.col.flags;
    const nameIdx = context.col.name;
    predicate = (row) => {
      if (bit !== undefined && flagsIdx !== undefined && (row[flagsIdx] & bit) !== 0) return true;
      if (nameIdx === undefined) return false;
      return context.resolveString(row[nameIdx]).toLowerCase().includes(body.toLowerCase());
    };
  } else {
    predicate = () => true;
  }

  return negate ? (row) => !predicate(row) : predicate;
}

/**
 * `imports:` and `importedby:`. The path is a prefix, so `imports:analyzer/`
 * finds everything that reaches into the analyzer. Resolved once per query.
 */
function edgePredicate(key, value, context) {
  const edges = context.edges;
  const col = context.col;
  if (!edges || !context.rows || col.id === undefined) return () => false;
  const pathIdx = col.path !== undefined ? col.path : col.name;
  const prefix = value.replace(/\*+$/, '');
  const targets = new Set();
  for (const row of context.rows) {
    if (context.resolveString(row[pathIdx]).toLowerCase().startsWith(prefix)) targets.add(row[col.id]);
  }
  const matches = new Set();
  const lookup = key === 'imports' ? edges.importers : edges.imports;
  for (const id of targets) {
    for (const other of lookup.get(id) || []) matches.add(other);
  }
  return (row) => matches.has(row[col.id]);
}

/** `[[from, to, violates], ...]` -> both directions, for the edge tokens and the overlay. */
export function edgeMaps(edgeList) {
  const imports = new Map();
  const importers = new Map();
  const violating = new Set(); // `${from}>${to}`
  for (const [from, to, violates] of edgeList || []) {
    if (!imports.has(from)) imports.set(from, []);
    if (!importers.has(to)) importers.set(to, []);
    imports.get(from).push(to);
    importers.get(to).push(from);
    if (violates) violating.add(`${from}>${to}`);
  }
  return { imports, importers, violating };
}

/**
 * Compile a query string into `(row) => boolean`. An empty/whitespace query
 * always matches everything (no filter active).
 *
 * Terms are ANDed; `OR` (or `|`) between groups of terms ORs the groups, so
 * `is:hotspot is:untested OR is:cycle` is "untested hotspots, or anything in a
 * cycle". `extra` supplies what some tokens need beyond the index itself:
 * `edges` (from `edgeMaps`), `rows` (the index) and `resolveDistrict(id)`.
 */
export function parseQuery(text, indexColumns, resolveString, resolveExt, extra = {}) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  const context = { col: columnIndex(indexColumns), resolveString, resolveExt, ...extra };
  const groups = [[]];
  for (const term of splitTerms(trimmed)) {
    if (term === 'OR' || term === '|' || term === '||') {
      if (groups[groups.length - 1].length) groups.push([]);
      continue;
    }
    groups[groups.length - 1].push(compileTerm(term, context));
  }
  const live = groups.filter((g) => g.length);
  if (!live.length) return null;
  return (row) => live.some((clauses) => clauses.every((clause) => clause(row)));
}

/** Run a compiled predicate over the whole index, returning matching ids and a summary. */
export function runQuery(rows, predicate, indexColumns) {
  const col = columnIndex(indexColumns);
  const idIdx = col.id ?? 0;
  const districtIdx = col.district ?? 1;
  const locIdx = col.loc;
  const matches = predicate ? rows.filter(predicate) : rows;
  const ids = new Set(matches.map((row) => row[idIdx]));
  const districts = new Set();
  let loc = 0;
  for (const row of matches) {
    districts.add(row[districtIdx]);
    if (locIdx !== undefined) loc += Number(row[locIdx]) || 0;
  }
  return { ids, count: matches.length, districts: districts.size, loc };
}

/**
 * Top languages, archetypes and named special files, for the chip row.
 * `resolveString`/`resolveExt` follow the same locked-city rules as queries.
 */
export function buildFacets(rows, indexColumns, resolveString, resolveExt) {
  const col = columnIndex(indexColumns);
  const languages = new Map();
  const archetypes = new Map();
  const specials = new Map();
  const SPECIAL_NAMES = new Set([
    'readme.md', 'readme', 'claude.md', 'license', 'license.md', 'dockerfile',
    'package.json', 'pyproject.toml', 'cargo.toml', 'go.mod',
  ]);

  for (const row of rows) {
    if (col.language !== undefined) {
      const lang = resolveString(row[col.language]);
      if (lang) languages.set(lang, (languages.get(lang) || 0) + 1);
    }
    if (col.archetype !== undefined) {
      const arch = row[col.archetype];
      if (arch) archetypes.set(arch, (archetypes.get(arch) || 0) + 1);
    }
    if (col.name !== undefined) {
      const name = resolveString(row[col.name]).toLowerCase();
      if (SPECIAL_NAMES.has(name) || name.startsWith('.github/workflows/')) {
        specials.set(name, (specials.get(name) || 0) + 1);
      }
    }
  }

  const toChips = (map, queryFor) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ label: key, count, query: queryFor(key) }));

  return {
    languages: toChips(languages, (key) => `lang:${key}`),
    archetypes: toChips(archetypes, (key) => `archetype:${key}`),
    specials: toChips(specials, (key) => `name:${key}`),
  };
}
