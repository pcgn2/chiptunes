const ORIGIN = 'https://keygenmusic.tk';

export function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function remoteUrl(path) {
  return ORIGIN + String(path).split('/').map(encodeURIComponent).join('/');
}

export function fileFormat(path) {
  const match = /\.([a-z0-9]+)$/i.exec(path || '');
  return match ? match[1].toUpperCase() : '?';
}

export function buildCatalog(rawTracks) {
  return rawTracks.map((raw, index) => {
    const title = raw.sn || raw.st || `Track ${index + 1}`;
    const artist = raw.rg || 'Unknown artist';
    const game = raw.mdt || '';
    return {
      id: raw.path,
      index,
      number: raw.n || index + 1,
      title,
      artist,
      game,
      path: raw.path,
      url: remoteUrl(raw.path),
      format: fileFormat(raw.path),
      haystack: normalize(`${title} ${artist} ${game} ${raw.st || ''}`),
    };
  });
}

const SORTS = {
  default: (a, b) => a.index - b.index,
  title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
  artist: (a, b) => a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' }) || a.title.localeCompare(b.title),
  game: (a, b) => a.game.localeCompare(b.game, undefined, { sensitivity: 'base' }) || a.title.localeCompare(b.title),
  number: (a, b) => a.number - b.number,
};

export function filterCatalog(tracks, { query = '', filter = 'all', format = 'all', sort = 'default', favorites, recent } = {}) {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const favSet = favorites instanceof Set ? favorites : new Set(favorites || []);
  const recentSet = new Set(recent || []);

  const result = tracks.filter((track) => {
    if (format !== 'all' && track.format !== format) return false;
    if (filter === 'favorites' && !favSet.has(track.id)) return false;
    if (filter === 'recent' && !recentSet.has(track.id)) return false;
    return words.every((word) => track.haystack.includes(word));
  });

  if (sort !== 'default' || filter !== 'all') result.sort(SORTS[sort] || SORTS.default);
  if (filter === 'recent' && sort === 'default') result.sort((a, b) => recent.indexOf(a.id) - recent.indexOf(b.id));
  return result;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
