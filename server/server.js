const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.resolve(__dirname, 'media');
const HOST = process.env.HOST || '0.0.0.0';
let soundcloud;
let ffmpeg;

function getSoundcloud() {
  if (!soundcloud) {
    try {
      soundcloud = require('soundcloud-downloader').default;
    } catch (_) {
      throw new Error('Chua cai soundcloud-downloader. Hay chay npm install');
    }
  }
  return soundcloud;
}

function getFfmpeg() {
  if (!ffmpeg) ffmpeg = require('ffmpeg-static');
  return ffmpeg;
}

function looksLikeMp3(filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size < 4) return false;
  const fd = fs.openSync(filePath, 'r');
  const header = Buffer.alloc(4);
  fs.readSync(fd, header, 0, 4, 0);
  fs.closeSync(fd);
  return header.toString('ascii', 0, 3) === 'ID3' ||
    (header[0] === 0xff && (header[1] & 0xe0) === 0xe0);
}

async function saveAsMp3(inputStream, target) {
  const converter = spawn(getFfmpeg(), [
    '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn',
    '-f', 'mp3', '-codec:a', 'libmp3lame', '-ar', '16000', '-ac', '1',
    '-b:a', '96k', 'pipe:1'
  ]);
  const output = fs.createWriteStream(target);
  let stderr = '';
  converter.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  inputStream.on('error', () => converter.kill('SIGTERM'));
  converter.stdin.on('error', () => {});
  output.on('error', () => converter.kill('SIGTERM'));
  inputStream.pipe(converter.stdin);
  converter.stdout.pipe(output);
  await new Promise((resolve, reject) => {
    converter.on('error', reject);
    converter.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`ffmpeg failed (${code}): ${stderr.trim()}`)));
  });
}

function normalizeName(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function walk(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const diskPath = path.join(dir, entry.name);
    const webPath = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) return walk(diskPath, webPath);
    if (!/\.(mp3|wav|ogg|m4a)$/i.test(entry.name)) return [];
    const stat = fs.statSync(diskPath);
    const category = webPath.startsWith('songs/') ? 'song' : 'story';
    return [{
      id: webPath.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-'),
      name: entry.name.replace(/\.[^.]+$/, ''),
      path: webPath,
      category,
      tags: category === 'song' ? ['music'] : ['story'],
      duration: 0,
      size: stat.size
    }];
  });
}

function getIndex() {
  return walk(ROOT).sort((a, b) => a.name.localeCompare(b.name));
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function streamFile(req, res, filePath) {
  if (!fs.existsSync(filePath)) return json(res, 404, { error: 'file not found' });
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const types = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' };
  const headers = { 'Content-Type': types[ext] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  const range = req.headers.range;

  if (!range) {
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    return fs.createReadStream(filePath).pipe(res);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return json(res, 416, { error: 'invalid range' });
  const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
  const end = match[2] ? Number(match[2]) : stat.size - 1;
  if (start < 0 || end < start || start >= stat.size) return json(res, 416, { error: 'range not satisfiable' });
  const safeEnd = Math.min(end, stat.size - 1);
  headers['Content-Range'] = `bytes ${start}-${safeEnd}/${stat.size}`;
  headers['Content-Length'] = safeEnd - start + 1;
  res.writeHead(206, headers);
  fs.createReadStream(filePath, { start, end: safeEnd }).pipe(res);
}

function localAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((x) => x && x.family === 'IPv4' && !x.internal).map((x) => x.address);
}

async function soundcloudSearch(query) {
  const result = await getSoundcloud().search({ query, limit: 10, resourceType: 'tracks' });
  return (result.collection || []).map((track) => ({
    id: `soundcloud-${track.id}`,
    name: `${track.user?.username || 'SoundCloud'} - ${track.title || 'Untitled'}`,
    title: track.title || 'Untitled',
    artist: track.user?.username || '',
    permalink_url: track.permalink_url || '',
    duration: Math.round((track.duration || 0) / 1000),
    playable: track.access === 'playable' || track.streamable === true
  }));
}

function safeFileName(value) {
  return String(value || 'soundcloud-track')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 120) || 'soundcloud-track';
}

async function downloadSoundcloudTrack(trackUrl) {
  const scdl = getSoundcloud();
  const info = await scdl.getInfo(trackUrl);
  const title = safeFileName(`${info.user?.username || 'SoundCloud'} - ${info.title}`);
  const target = path.join(ROOT, 'songs', `${title}.mp3`);
  if (fs.existsSync(target) && !looksLikeMp3(target)) fs.unlinkSync(target);
  if (!fs.existsSync(target)) {
    const stream = await scdl.download(trackUrl);
    await saveAsMp3(stream, target);
  }
  return { name: title, path: `songs/${path.basename(target)}`, index: getIndex() };
}

function isSoundcloudUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return ['soundcloud.com', 'www.soundcloud.com', 'on.soundcloud.com', 'soundcloud.app.goo.gl'].includes(host);
  } catch (_) { return false; }
}

fs.mkdirSync(path.join(ROOT, 'songs'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'stories'), { recursive: true });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const index = getIndex();

  if (url.pathname === '/') {
    return json(res, 200, {
      name: 'Xiaozhi Music Server',
      ok: true,
      health: '/health',
      index: '/index.json',
      search: '/api/soundcloud/search?q=ten+bai',
      songs: index.length
    });
  }
  if (url.pathname === '/health') return json(res, 200, { ok: true, count: index.length });
  if (url.pathname === '/index.json') return json(res, 200, index);
  if (url.pathname === '/api/search') {
    if (url.searchParams.get('soundcloud') === '1') {
      const query = url.searchParams.get('q') || '';
      if (!query.trim()) return json(res, 400, { error: 'Thieu q' });
      return soundcloudSearch(query).then((items) => json(res, 200, items))
        .catch((error) => json(res, 502, { error: error.message }));
    }
    const query = normalizeName(url.searchParams.get('q') || '');
    return json(res, 200, index.filter((item) => normalizeName(`${item.name} ${item.tags.join(' ')}`).includes(query)));
  }
  if (url.pathname === '/api/soundcloud/search') {
    const query = url.searchParams.get('q') || '';
    if (!query.trim()) return json(res, 400, { error: 'Thieu q' });
    return soundcloudSearch(query).then((items) => json(res, 200, items))
      .catch((error) => json(res, 502, { error: error.message }));
  }
  if (url.pathname === '/api/soundcloud/download') {
    const trackUrl = url.searchParams.get('url') || '';
    if (!isSoundcloudUrl(trackUrl)) return json(res, 400, { error: 'url SoundCloud khong hop le' });
    return downloadSoundcloudTrack(trackUrl).then((result) => json(res, 200, result))
      .catch((error) => json(res, 502, { error: error.message }));
  }
  if (url.pathname === '/api/info') return json(res, 200, { name: 'Xiaozhi Music Server', port: PORT, urls: localAddresses().map((ip) => `http://${ip}:${PORT}`), count: index.length });
  if (url.pathname.startsWith('/songs/') || url.pathname.startsWith('/stories/')) {
    const relative = decodeURIComponent(url.pathname.slice(1));
    const filePath = path.resolve(ROOT, relative);
    if (!filePath.startsWith(ROOT + path.sep)) return json(res, 400, { error: 'invalid path' });
    return streamFile(req, res, filePath);
  }
  json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`Xiaozhi server listening on port ${PORT}`);
  for (const ip of localAddresses()) console.log(`ESP32 base URL: http://${ip}:${PORT}/`);
  console.log(`Put MP3 files in: ${ROOT}`);
});
