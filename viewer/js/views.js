/**
 * Saved views: the exact view on screen, as a link.
 *
 * An architect who finds something wants to point a colleague at it -- in a
 * pull request, a design doc, a chat. The URL hash carries everything that
 * makes a view: the camera, the filter, the colour lens (and the author, for
 * the territory lens), the selected building or district, the History
 * slider, and whether the view is the plan (map) view. Nothing about the repository is in the link beyond what the query
 * itself says, so a view of a locked city stays as opaque as the city.
 *
 * Format: `#view=` + URL-safe base64 of a small JSON object. Unknown or broken
 * hashes are ignored rather than half-applied.
 */

const KEY = 'view';

function encode(data) {
  const json = JSON.stringify(data);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

const round = (value, places = 1) => Math.round(value * 10 ** places) / 10 ** places;

/** Capture a view from its parts. `selection` is `{kind: 'building'|'district', id}` or null. */
export function captureView({ position, yaw, pitch, filter, lens, author, selection, timeline, mode }) {
  const view = { p: [round(position.x), round(position.y), round(position.z)], yw: round(yaw, 3), pt: round(pitch, 3) };
  // Only the plan view is recorded: every other mode reopens as free flight.
  if (mode === 'top') view.m = 't';
  if (filter) view.f = filter;
  if (lens && lens !== 'archetype') view.l = lens;
  if (author) view.a = author;
  if (selection) view.s = `${selection.kind === 'district' ? 'd' : 'b'}${selection.id}`;
  if (timeline !== null && timeline !== undefined) view.t = Math.round(timeline);
  return view;
}

export function viewToHash(view) {
  return `#${KEY}=${encode(view)}`;
}

/** The view in a hash, or null when there is none or it is unreadable. */
export function viewFromHash(hash) {
  const text = String(hash || '').replace(/^#/, '');
  const params = new URLSearchParams(text);
  const raw = params.get(KEY);
  if (!raw) return null;
  try {
    const view = decode(raw);
    if (!view || !Array.isArray(view.p) || view.p.length !== 3 || view.p.some((v) => !Number.isFinite(v))) return null;
    const selection = typeof view.s === 'string' && /^[bd]\d+$/.test(view.s)
      ? { kind: view.s[0] === 'd' ? 'district' : 'building', id: Number(view.s.slice(1)) }
      : null;
    return {
      position: { x: view.p[0], y: view.p[1], z: view.p[2] },
      yaw: Number(view.yw) || 0,
      pitch: Number(view.pt) || 0,
      filter: typeof view.f === 'string' ? view.f : '',
      lens: typeof view.l === 'string' ? view.l : 'archetype',
      author: typeof view.a === 'string' ? view.a : '',
      selection,
      timeline: Number.isFinite(view.t) ? view.t : null,
      mode: view.m === 't' ? 'top' : 'fly',
    };
  } catch (error) {
    return null;
  }
}

/** Put text on the clipboard, falling back to a prompt the reader can copy from. */
export async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    // Fall through: clipboard permission can be denied in an iframe or on http.
  }
  window.prompt('Copy this link to the view:', text);
  return false;
}
