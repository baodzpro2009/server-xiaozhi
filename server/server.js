const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const { spawn } = require('child_process');

/*
=========================================================
 Xiaozhi Music Server
 Local + SoundCloud + YouTube
=========================================================
*/

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const ROOT = path.resolve(__dirname, 'media');
const SONGS_DIR = path.join(ROOT, 'songs');
const STORIES_DIR = path.join(ROOT, 'stories');

let soundcloud = null;
let ffmpeg = null;
let youtubedl = null;

/*
=========================================================
 LOAD PACKAGES
=========================================================
*/

function getSoundcloud() {
  if (!soundcloud) {
    try {
      const sc = require('soundcloud-downloader');
      soundcloud = sc.default || sc;
    } catch (error) {
      throw new Error(
        'Chua cai soundcloud-downloader. Chay: npm install soundcloud-downloader'
      );
    }
  }

  return soundcloud;
}

function getFfmpeg() {
  if (!ffmpeg) {
    try {
      ffmpeg = require('ffmpeg-static');
    } catch (error) {
      throw new Error(
        'Chua cai ffmpeg-static. Chay: npm install ffmpeg-static'
      );
    }
  }

  return ffmpeg;
}

function getYoutubeDL() {
  if (!youtubedl) {
    try {
      youtubedl = require('youtube-dl-exec');
    } catch (error) {
      throw new Error(
        'Chua cai youtube-dl-exec. Chay: npm install youtube-dl-exec'
      );
    }
  }

  return youtubedl;
}

/*
=========================================================
 DIRECTORIES
=========================================================
*/

fs.mkdirSync(SONGS_DIR, {
  recursive: true
});

fs.mkdirSync(STORIES_DIR, {
  recursive: true
});

/*
=========================================================
 HELPERS
=========================================================
*/

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function safeFileName(value) {
  return String(value || 'track')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'track';
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

function isYouTubeUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();

    return [
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com',
      'music.youtube.com',
      'youtu.be',
      'www.youtu.be'
    ].includes(host);
  } catch (_) {
    return false;
  }
}

function isSoundcloudUrl(value) {
  try {
    const host = new URL(value)
      .hostname
      .toLowerCase();

    return [
      'soundcloud.com',
      'www.soundcloud.com',
      'on.soundcloud.com',
      'soundcloud.app.goo.gl'
    ].includes(host);
  } catch (_) {
    return false;
  }
}

function localAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(
      (x) =>
        x &&
        x.family === 'IPv4' &&
        !x.internal
    )
    .map((x) => x.address);
}

/*
=========================================================
 MP3 CHECK
=========================================================
*/

function looksLikeMp3(filePath) {
  if (
    !fs.existsSync(filePath) ||
    fs.statSync(filePath).size < 4
  ) {
    return false;
  }

  const fd = fs.openSync(filePath, 'r');
  const header = Buffer.alloc(4);

  fs.readSync(
    fd,
    header,
    0,
    4,
    0
  );

  fs.closeSync(fd);

  return (
    header.toString('ascii', 0, 3) === 'ID3' ||
    (
      header[0] === 0xff &&
      (header[1] & 0xe0) === 0xe0
    )
  );
}

/*
=========================================================
 FFMPEG
=========================================================
*/

async function saveAsMp3(inputStream, target) {
  const converter = spawn(
    getFfmpeg(),
    [
      '-hide_banner',
      '-loglevel',
      'error',

      '-i',
      'pipe:0',

      '-vn',

      '-f',
      'mp3',

      '-codec:a',
      'libmp3lame',

      '-ar',
      '16000',

      '-ac',
      '1',

      '-b:a',
      '96k',

      'pipe:1'
    ],
    {
      stdio: [
        'pipe',
        'pipe',
        'pipe'
      ]
    }
  );

  const output =
    fs.createWriteStream(target);

  let stderr = '';

  converter.stderr.on(
    'data',
    (chunk) => {
      stderr += chunk.toString();
    }
  );

  inputStream.on(
    'error',
    () => {
      try {
        converter.kill('SIGTERM');
      } catch (_) { }
    }
  );

  converter.stdin.on(
    'error',
    () => { }
  );

  output.on(
    'error',
    () => {
      try {
        converter.kill('SIGTERM');
      } catch (_) { }
    }
  );

  inputStream.pipe(
    converter.stdin
  );

  converter.stdout.pipe(
    output
  );

  await new Promise(
    (resolve, reject) => {
      converter.on(
        'error',
        reject
      );

      output.on(
        'finish',
        () => { }
      );

      converter.on(
        'close',
        (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(
                `ffmpeg failed (${code}): ${stderr.trim()}`
              )
            );
          }
        }
      );
    }
  );
}

/*
=========================================================
 MEDIA INDEX
=========================================================
*/

function walk(dir, prefix = '') {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(
      dir,
      {
        withFileTypes: true
      }
    )
    .flatMap((entry) => {
      const diskPath =
        path.join(
          dir,
          entry.name
        );

      const webPath =
        path.posix.join(
          prefix,
          entry.name
        );

      if (entry.isDirectory()) {
        return walk(
          diskPath,
          webPath
        );
      }

      if (
        !/\.(mp3|wav|ogg|m4a)$/i.test(
          entry.name
        )
      ) {
        return [];
      }

      const stat =
        fs.statSync(diskPath);

      const category =
        webPath.startsWith('songs/')
          ? 'song'
          : 'story';

      return [
        {
          id: webPath
            .replace(/\.[^.]+$/, '')
            .replace(
              /[^a-zA-Z0-9_-]+/g,
              '-'
            ),

          name:
            entry.name.replace(
              /\.[^.]+$/,
              ''
            ),

          path: webPath,

          category,

          tags:
            category === 'song'
              ? ['music']
              : ['story'],

          duration: 0,

          size: stat.size
        }
      ];
    });
}

function getIndex() {
  return walk(ROOT).sort(
    (a, b) =>
      a.name.localeCompare(
        b.name
      )
  );
}

/*
=========================================================
 FILE STREAM + RANGE
=========================================================
*/

function streamFile(
  req,
  res,
  filePath
) {
  if (!fs.existsSync(filePath)) {
    return json(
      res,
      404,
      {
        error: 'file not found'
      }
    );
  }

  const stat =
    fs.statSync(filePath);

  if (!stat.isFile()) {
    return json(
      res,
      404,
      {
        error: 'not a file'
      }
    );
  }

  const ext =
    path.extname(filePath)
      .toLowerCase();

  const types = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4'
  };

  const headers = {
    'Content-Type':
      types[ext] ||
      'application/octet-stream',

    'Accept-Ranges':
      'bytes',

    'Access-Control-Allow-Origin':
      '*'
  };

  const range =
    req.headers.range;

  if (!range) {
    headers[
      'Content-Length'
    ] = stat.size;

    res.writeHead(
      200,
      headers
    );

    return fs
      .createReadStream(
        filePath
      )
      .pipe(res);
  }

  const match =
    /^bytes=(\d*)-(\d*)$/
      .exec(range);

  if (!match) {
    return json(
      res,
      416,
      {
        error:
          'invalid range'
      }
    );
  }

  const start =
    match[1]
      ? Number(match[1])
      : Math.max(
        0,
        stat.size -
        Number(match[2])
      );

  const end =
    match[2]
      ? Number(match[2])
      : stat.size - 1;

  if (
    start < 0 ||
    end < start ||
    start >= stat.size
  ) {
    return json(
      res,
      416,
      {
        error:
          'range not satisfiable'
      }
    );
  }

  const safeEnd =
    Math.min(
      end,
      stat.size - 1
    );

  headers[
    'Content-Range'
  ] =
    `bytes ${start}-${safeEnd}/${stat.size}`;

  headers[
    'Content-Length'
  ] =
    safeEnd - start + 1;

  res.writeHead(
    206,
    headers
  );

  fs
    .createReadStream(
      filePath,
      {
        start,
        end: safeEnd
      }
    )
    .pipe(res);
}

/*
=========================================================
 SOUNDCLOUD SEARCH
=========================================================
*/

async function soundcloudSearch(
  query
) {
  const result =
    await getSoundcloud().search({
      query,
      limit: 10,
      resourceType: 'tracks'
    });

  return (
    result.collection || []
  ).map(
    (track) => ({
      id:
        `soundcloud-${track.id}`,

      name:
        `${track.user?.username || 'SoundCloud'} - ${track.title || 'Untitled'}`,

      title:
        track.title ||
        'Untitled',

      artist:
        track.user?.username ||
        '',

      permalink_url:
        track.permalink_url ||
        '',

      duration:
        Math.round(
          (track.duration || 0) /
          1000
        ),

      playable:
        track.access ===
        'playable' ||
        track.streamable ===
        true,

      source:
        'soundcloud'
    })
  );
}

/*
=========================================================
 SOUNDCLOUD DOWNLOAD
=========================================================
*/

async function downloadSoundcloudTrack(
  trackUrl
) {
  const scdl =
    getSoundcloud();

  const info =
    await scdl.getInfo(
      trackUrl
    );

  const title =
    safeFileName(
      `${info.user?.username || 'SoundCloud'} - ${info.title || 'Untitled'}`
    );

  const target =
    path.join(
      SONGS_DIR,
      `${title}.mp3`
    );

  if (
    fs.existsSync(target) &&
    !looksLikeMp3(target)
  ) {
    fs.unlinkSync(target);
  }

  if (!fs.existsSync(target)) {
    const stream =
      await scdl.download(
        trackUrl
      );

    await saveAsMp3(
      stream,
      target
    );
  }

  return {
    name: title,

    title:
      info.title ||
      title,

    artist:
      info.user?.username ||
      '',

    source:
      'soundcloud',

    path:
      `songs/${path.basename(
        target
      )}`,

    index:
      getIndex()
  };
}

/*
=========================================================
 YOUTUBE SEARCH
=========================================================
*/

async function youtubeSearch(
  query
) {
  const yt =
    getYoutubeDL();

  const result =
    await yt(
      `ytsearch10:${query}`,
      {
        dumpSingleJson: true,
        flatPlaylist: true,
        skipDownload: true,
        noWarnings: true,
        noCheckCertificates: true,
        quiet: true
      }
    );

  const entries =
    Array.isArray(
      result?.entries
    )
      ? result.entries
      : [];

  return entries
    .filter(
      (video) =>
        video &&
        video.id
    )
    .map(
      (video) => ({
        id:
          `youtube-${video.id}`,

        videoId:
          video.id,

        name:
          video.title ||
          'Untitled',

        title:
          video.title ||
          'Untitled',

        artist:
          video.uploader ||
          video.channel ||
          '',

        url:
          video.webpage_url ||
          `https://www.youtube.com/watch?v=${video.id}`,

        thumbnail:
          video.thumbnail ||
          `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,

        duration:
          Number(
            video.duration || 0
          ),

        durationText:
          video.duration_string ||
          '',

        views:
          Number(
            video.view_count || 0
          ),

        source:
          'youtube',

        playable:
          true
      })
    );
}

/*
=========================================================
 YOUTUBE INFO
=========================================================
*/

async function youtubeInfo(
  videoUrl
) {
  const yt =
    getYoutubeDL();

  const info =
    await yt(
      videoUrl,
      {
        dumpSingleJson: true,
        skipDownload: true,
        noWarnings: true,
        noCheckCertificates: true,
        quiet: true
      }
    );

  return {
    id:
      `youtube-${info.id}`,

    videoId:
      info.id,

    title:
      info.title ||
      'Untitled',

    author:
      info.uploader ||
      info.channel ||
      '',

    url:
      info.webpage_url ||
      videoUrl,

    thumbnail:
      info.thumbnail ||
      `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`,

    duration:
      Number(
        info.duration || 0
      ),

    views:
      Number(
        info.view_count || 0
      ),

    source:
      'youtube'
  };
}

/*
=========================================================
 YOUTUBE AUDIO STREAM
=========================================================

 YouTube audio
      ↓
     yt-dlp
      ↓
   raw audio
      ↓
    ffmpeg
      ↓
 MP3 16kHz mono 96k
      ↓
    Xiaozhi
=========================================================
*/

async function streamYouTubeAudio(
  req,
  res,
  videoUrl
) {
  const yt =
    getYoutubeDL();

  const converter =
    spawn(
      getFfmpeg(),
      [
        '-hide_banner',
        '-loglevel',
        'error',

        '-i',
        'pipe:0',

        '-vn',

        '-f',
        'mp3',

        '-codec:a',
        'libmp3lame',

        '-ar',
        '16000',

        '-ac',
        '1',

        '-b:a',
        '96k',

        'pipe:1'
      ],
      {
        stdio: [
          'pipe',
          'pipe',
          'pipe'
        ]
      }
    );

  let ytProcess = null;
  let ffmpegError = '';

  converter.stderr.on(
    'data',
    (chunk) => {
      ffmpegError +=
        chunk.toString();
    }
  );

  try {
    /*
     * yt-dlp xuất audio ra stdout
     */
    ytProcess =
      yt.exec(
        videoUrl,
        {
          format:
            'bestaudio/best',

          output:
            '-',

          noPlaylist:
            true,

          noWarnings:
            true,

          quiet:
            true,

          noCheckCertificates:
            true
        }
      );

    ytProcess.stdout.pipe(
      converter.stdin
    );

    /*
     * Khi yt-dlp lỗi
     */
    ytProcess.stderr.on(
      'data',
      (chunk) => {
        const text =
          chunk.toString();

        if (text.trim()) {
          console.error(
            'yt-dlp:',
            text.trim()
          );
        }
      }
    );

    ytProcess.on(
      'error',
      (error) => {
        console.error(
          'YouTube process error:',
          error.message
        );

        try {
          converter.kill(
            'SIGTERM'
          );
        } catch (_) { }
      }
    );

    /*
     * Client đóng kết nối
     */
    req.on(
      'close',
      () => {
        try {
          if (
            ytProcess &&
            ytProcess.kill
          ) {
            ytProcess.kill(
              'SIGTERM'
            );
          }
        } catch (_) { }

        try {
          converter.kill(
            'SIGTERM'
          );
        } catch (_) { }
      }
    );

    /*
     * Header MP3
     */
    res.writeHead(
      200,
      {
        'Content-Type':
          'audio/mpeg',

        'Transfer-Encoding':
          'chunked',

        'Cache-Control':
          'no-cache',

        'Access-Control-Allow-Origin':
          '*',

        'Accept-Ranges':
          'none'
      }
    );

    /*
     * ffmpeg MP3 -> HTTP
     */
    converter.stdout.pipe(
      res
    );

    converter.on(
      'close',
      (code) => {
        if (
          code !== 0 &&
          !res.destroyed
        ) {
          console.error(
            'FFmpeg YouTube:',
            ffmpegError.trim()
          );

          try {
            res.end();
          } catch (_) { }
        }
      }
    );

  } catch (error) {
    console.error(
      'YouTube stream error:',
      error.message
    );

    try {
      if (
        ytProcess &&
        ytProcess.kill
      ) {
        ytProcess.kill(
          'SIGTERM'
        );
      }
    } catch (_) { }

    try {
      converter.kill(
        'SIGTERM'
      );
    } catch (_) { }

    if (!res.headersSent) {
      return json(
        res,
        502,
        {
          error:
            error.message
        }
      );
    }

    res.destroy();
  }
}

/*
=========================================================
 YOUTUBE DOWNLOAD MP3
=========================================================
*/

async function downloadYouTubeTrack(
  videoUrl
) {
  const yt =
    getYoutubeDL();

  /*
   * Lấy thông tin
   */
  const info =
    await yt(
      videoUrl,
      {
        dumpSingleJson: true,
        skipDownload: true,
        noWarnings: true,
        noCheckCertificates: true,
        quiet: true
      }
    );

  const title =
    safeFileName(
      `${info.uploader || info.channel || 'YouTube'} - ${info.title || 'Untitled'}`
    );

  const target =
    path.join(
      SONGS_DIR,
      `${title}.mp3`
    );

  /*
   * Nếu file cũ lỗi thì xóa
   */
  if (
    fs.existsSync(target) &&
    !looksLikeMp3(target)
  ) {
    fs.unlinkSync(target);
  }

  /*
   * Chưa có thì tải
   */
  if (!fs.existsSync(target)) {
    const process =
      yt.exec(
        videoUrl,
        {
          extractAudio: true,

          audioFormat:
            'mp3',

          audioQuality:
            '96K',

          output:
            target,

          noPlaylist:
            true,

          noWarnings:
            true,

          quiet:
            true,

          noCheckCertificates:
            true,

          ffmpegLocation:
            getFfmpeg()
        }
      );

    let stderr = '';

    process.stderr.on(
      'data',
      (chunk) => {
        stderr +=
          chunk.toString();
      }
    );

    await process;

    if (
      !fs.existsSync(target)
    ) {
      throw new Error(
        stderr.trim() ||
        'YouTube download failed'
      );
    }
  }

  /*
   * Kiểm tra MP3
   */
  if (!looksLikeMp3(target)) {
    try {
      fs.unlinkSync(target);
    } catch (_) { }

    throw new Error(
      'File YouTube tai ve khong phai MP3 hop le'
    );
  }

  return {
    id:
      `youtube-${info.id}`,

    videoId:
      info.id,

    name:
      title,

    title:
      info.title ||
      'Untitled',

    artist:
      info.uploader ||
      info.channel ||
      '',

    source:
      'youtube',

    path:
      `songs/${path.basename(
        target
      )}`,

    url:
      info.webpage_url ||
      videoUrl,

    duration:
      Number(
        info.duration || 0
      ),

    index:
      getIndex()
  };
}

/*
=========================================================
 SERVER
=========================================================
*/

const server =
  http.createServer(
    async (req, res) => {
      let url;

      try {
        url = new URL(
          req.url,
          `http://${req.headers.host || 'localhost'}`
        );
      } catch (error) {
        return json(
          res,
          400,
          {
            error:
              'Invalid URL'
          }
        );
      }

      const index =
        getIndex();

      /*
      ===============================================
      HOME
      ===============================================
      */

      if (
        url.pathname === '/'
      ) {
        return json(
          res,
          200,
          {
            name:
              'Xiaozhi Music Server',

            ok:
              true,

            health:
              '/health',

            index:
              '/index.json',

            localSearch:
              '/api/search?q=ten+bai',

            soundcloudSearch:
              '/api/soundcloud/search?q=ten+bai',

            youtubeSearch:
              '/api/youtube/search?q=ten+bai',

            youtubeStream:
              '/api/youtube/stream?url=YOUTUBE_URL',

            youtubeDownload:
              '/api/youtube/download?url=YOUTUBE_URL',

            songs:
              index.length
          }
        );
      }

      /*
      ===============================================
      HEALTH
      ===============================================
      */

      if (
        url.pathname ===
        '/health'
      ) {
        return json(
          res,
          200,
          {
            ok:
              true,

            count:
              index.length,

            youtube:
              true,

            soundcloud:
              true
          }
        );
      }

      /*
      ===============================================
      INDEX
      ===============================================
      */

      if (
        url.pathname ===
        '/index.json'
      ) {
        return json(
          res,
          200,
          index
        );
      }

      /*
      ===============================================
      LOCAL SEARCH
      ===============================================
      */

      if (
        url.pathname ===
        '/api/search'
      ) {
        const query =
          normalizeName(
            url.searchParams.get(
              'q'
            ) || ''
          );

        if (!query) {
          return json(
            res,
            200,
            index
          );
        }

        return json(
          res,
          200,
          index.filter(
            (item) =>
              normalizeName(
                `${item.name} ${item.tags.join(' ')}`
              ).includes(query)
          )
        );
      }

      /*
      ===============================================
      SOUNDCLOUD SEARCH
      ===============================================
      */

      if (
        url.pathname ===
        '/api/soundcloud/search'
      ) {
        const query =
          url.searchParams.get(
            'q'
          ) || '';

        if (!query.trim()) {
          return json(
            res,
            400,
            {
              error:
                'Thieu q'
            }
          );
        }

        try {
          const items =
            await soundcloudSearch(
              query
            );

          return json(
            res,
            200,
            items
          );
        } catch (error) {
          console.error(
            'SoundCloud search:',
            error.message
          );

          return json(
            res,
            502,
            {
              error:
                error.message
            }
          );
        }
      }

      /*
      ===============================================
      SOUNDCLOUD DOWNLOAD
      ===============================================
      */

      if (
        url.pathname ===
        '/api/soundcloud/download'
      ) {
        const trackUrl =
          url.searchParams.get(
            'url'
          ) || '';

        if (
          !isSoundcloudUrl(
            trackUrl
          )
        ) {
          return json(
            res,
            400,
            {
              error:
                'url SoundCloud khong hop le'
            }
          );
        }

        try {
          const result =
            await downloadSoundcloudTrack(
              trackUrl
            );

          return json(
            res,
            200,
            result
          );
        } catch (error) {
          console.error(
            'SoundCloud download:',
            error.message
          );

          return json(
            res,
            502,
            {
              error:
                error.message
            }
          );
        }
      }

      /*
      ===============================================
      YOUTUBE SEARCH
      ===============================================
      */

      if (
        url.pathname ===
        '/api/youtube/search'
      ) {
        const query =
          url.searchParams.get(
            'q'
          ) || '';

        if (!query.trim()) {
          return json(
            res,
            400,
            {
              error:
                'Thieu q'
            }
          );
        }

        try {
          console.log(
            `YouTube search: ${query}`
          );

          const items =
            await youtubeSearch(
              query
            );

          return json(
            res,
            200,
            items
          );
        } catch (error) {
          console.error(
            'YouTube search:',
            error.message
          );

          return json(
            res,
            502,
            {
              error:
                error.message
            }
          );
        }
      }

      /*
      ===============================================
      YOUTUBE INFO
      ===============================================
      */

      if (
        url.pathname ===
        '/api/youtube/info'
      ) {
        const videoUrl =
          url.searchParams.get(
            'url'
          ) || '';

        if (
          !isYouTubeUrl(
            videoUrl
          )
        ) {
          return json(
            res,
            400,
            {
              error:
                'URL YouTube khong hop le'
            }
          );
        }

        try {
          const info =
            await youtubeInfo(
              videoUrl
            );

          return json(
            res,
            200,
            info
          );
        } catch (error) {
          console.error(
            'YouTube info:',
            error.message
          );

          return json(
            res,
            502,
            {
              error:
                error.message
            }
          );
        }
      }

      /*
      ===============================================
      YOUTUBE STREAM
      ===============================================
      */

      if (
        url.pathname ===
        '/api/youtube/stream'
      ) {
        const videoUrl =
          url.searchParams.get(
            'url'
          ) || '';

        if (
          !isYouTubeUrl(
            videoUrl
          )
        ) {
          return json(
            res,
            400,
            {
              error:
                'URL YouTube khong hop le'
            }
          );
        }

        return streamYouTubeAudio(
          req,
          res,
          videoUrl
        );
      }

      /*
      ===============================================
      YOUTUBE DOWNLOAD
      ===============================================
      */

      if (
        url.pathname ===
        '/api/youtube/download'
      ) {
        const videoUrl =
          url.searchParams.get(
            'url'
          ) || '';

        if (
          !isYouTubeUrl(
            videoUrl
          )
        ) {
          return json(
            res,
            400,
            {
              error:
                'URL YouTube khong hop le'
            }
          );
        }

        try {
          console.log(
            `YouTube download: ${videoUrl}`
          );

          const result =
            await downloadYouTubeTrack(
              videoUrl
            );

          return json(
            res,
            200,
            result
          );
        } catch (error) {
          console.error(
            'YouTube download:',
            error.message
          );

          return json(
            res,
            502,
            {
              error:
                error.message
            }
          );
        }
      }

      /*
      ===============================================
      SERVER INFO
      ===============================================
      */

      if (
        url.pathname ===
        '/api/info'
      ) {
        return json(
          res,
          200,
          {
            name:
              'Xiaozhi Music Server',

            port:
              PORT,

            host:
              HOST,

            urls:
              localAddresses().map(
                (ip) =>
                  `http://${ip}:${PORT}/`
              ),

            count:
              index.length,

            features: [
              'local',
              'soundcloud',
              'youtube'
            ]
          }
        );
      }

      /*
      ===============================================
      MEDIA
      ===============================================
      */

      if (
        url.pathname.startsWith(
          '/songs/'
        ) ||
        url.pathname.startsWith(
          '/stories/'
        )
      ) {
        let relative;

        try {
          relative =
            decodeURIComponent(
              url.pathname.slice(1)
            );
        } catch (_) {
          return json(
            res,
            400,
            {
              error:
                'invalid path'
            }
          );
        }

        const filePath =
          path.resolve(
            ROOT,
            relative
          );

        if (
          !filePath.startsWith(
            ROOT + path.sep
          )
        ) {
          return json(
            res,
            400,
            {
              error:
                'invalid path'
            }
          );
        }

        return streamFile(
          req,
          res,
          filePath
        );
      }

      /*
      ===============================================
      404
      ===============================================
      */

      return json(
        res,
        404,
        {
          error:
            'not found'
        }
      );
    }
  );

/*
=========================================================
 START
=========================================================
*/

server.listen(
  PORT,
  HOST,
  () => {
    console.log('');
    console.log(
      '=========================================='
    );
    console.log(
      '       XIAOZHI MUSIC SERVER'
    );
    console.log(
      '=========================================='
    );

    console.log(
      `Server: http://localhost:${PORT}/`
    );

    for (
      const ip of localAddresses()
    ) {
      console.log(
        `ESP32:  http://${ip}:${PORT}/`
      );
    }

    console.log(
      `Media:  ${ROOT}`
    );

    console.log(
      '------------------------------------------'
    );

    console.log(
      `Local search:      /api/search?q=...`
    );

    console.log(
      `SoundCloud search: /api/soundcloud/search?q=...`
    );

    console.log(
      `YouTube search:    /api/youtube/search?q=...`
    );

    console.log(
      `YouTube stream:    /api/youtube/stream?url=...`
    );

    console.log(
      `YouTube download:  /api/youtube/download?url=...`
    );

    console.log(
      '=========================================='
    );
    console.log('');
  }
);
