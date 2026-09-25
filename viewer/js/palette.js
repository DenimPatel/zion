/**
 * Go to anything: Ctrl+K (or /) opens a search over every file and folder in
 * the repository -- not just the resident ones, because it reads `index.json`
 * -- and Enter flies there.
 *
 * Matching is a subsequence match scored like an editor's file finder: letters
 * in order, with points for runs of consecutive letters, for starting a path
 * segment, and for landing in the file name rather than its folders. A locked
 * city has no paths to search, so it offers folders by their labels only and
 * says so.
 */

const MAX_RESULTS = 12;

/** Subsequence score of `needle` in `hay` (both lower case), or -1. */
export function fuzzyScore(needle, hay) {
  if (!needle) return 0;
  let score = 0;
  let from = 0;
  let run = 0;
  const nameStart = hay.lastIndexOf('/') + 1;
  for (let i = 0; i < needle.length; i++) {
    const at = hay.indexOf(needle[i], from);
    if (at < 0) return -1;
    if (at === from && i > 0) {
      run += 1;
      score += 4 + run;
    } else {
      run = 0;
      score += 1;
    }
    const prev = at > 0 ? hay[at - 1] : '/';
    if (prev === '/' || prev === '_' || prev === '-' || prev === '.') score += 3;
    if (at >= nameStart) score += 2;
    from = at + 1;
  }
  // Shorter candidates win ties: `main.js` before `domain/main_test.js`.
  return score - hay.length * 0.02;
}

export class GoToPalette {
  /**
   * `host`:
   *   candidates()   [{kind: 'building'|'district', id, text, hint}]
   *   pick(item)     fly there
   *   locked()       true while the city is locked
   */
  constructor(root, host) {
    this.root = root;
    this.host = host;
    this.input = root.querySelector('input');
    this.list = root.querySelector('ol');
    this.note = root.querySelector('.palette-note');
    this.items = [];
    this.results = [];
    this.index = 0;
    this.input.addEventListener('input', () => this.search());
    this.input.addEventListener('keydown', (event) => this._key(event));
    root.addEventListener('mousedown', (event) => {
      if (event.target === root) this.close();
    });
  }

  get isOpen() {
    return !this.root.hidden;
  }

  open() {
    this.items = this.host.candidates().map((item) => ({ ...item, hay: item.text.toLowerCase() }));
    this.note.textContent = this.host.locked()
      ? 'Locked city: only folders can be found, by their labels. Press U to unlock.'
      : `${this.items.length.toLocaleString()} files and folders · ↑↓ to choose · Enter to fly · Esc to close`;
    this.root.hidden = false;
    this.input.value = '';
    this.search();
    this.input.focus();
  }

  close() {
    this.root.hidden = true;
    this.input.blur();
  }

  search() {
    const needle = this.input.value.trim().toLowerCase().replace(/\s+/g, '');
    const scored = [];
    for (const item of this.items) {
      const score = fuzzyScore(needle, item.hay);
      if (score < 0) continue;
      // Folders first on an empty query; otherwise purely by match.
      scored.push({ item, score: needle ? score : item.kind === 'district' ? 1 : 0 });
    }
    scored.sort((a, b) => b.score - a.score || a.item.text.length - b.item.text.length);
    this.results = scored.slice(0, MAX_RESULTS).map((s) => s.item);
    this.index = 0;
    this.render();
  }

  render() {
    this.list.innerHTML = '';
    this.results.forEach((item, i) => {
      const li = document.createElement('li');
      li.className = i === this.index ? 'active' : '';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === this.index));
      const kind = document.createElement('span');
      kind.className = `palette-kind ${item.kind}`;
      kind.textContent = item.kind === 'district' ? 'folder' : 'file';
      const text = document.createElement('span');
      text.className = 'palette-text';
      text.textContent = item.text;
      li.append(kind, text);
      if (item.hint) {
        const hint = document.createElement('span');
        hint.className = 'palette-hint';
        hint.textContent = item.hint;
        li.append(hint);
      }
      li.addEventListener('mousedown', (event) => {
        event.preventDefault();
        this.choose(i);
      });
      this.list.append(li);
    });
    if (!this.results.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nothing matches.';
      this.list.append(li);
    }
  }

  choose(i) {
    const item = this.results[i];
    if (!item) return;
    this.close();
    this.host.pick(item);
  }

  _key(event) {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.index = Math.min(this.results.length - 1, this.index + 1);
      this.render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.index = Math.max(0, this.index - 1);
      this.render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.choose(this.index);
    }
  }
}
