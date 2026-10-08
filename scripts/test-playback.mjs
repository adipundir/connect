import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, devices, firefox, webkit } from 'playwright';

// Generate actual HLS video and audio. The browser decodes it; media APIs are
// never mocked. Requests for demo data stay local to this test.
const mediaDir = await mkdtemp(join(tmpdir(), 'connect-playback-'));
const generated = spawnSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc2=size=320x200:rate=24',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-g', '48', '-c:a', 'aac', '-b:a', '96k', '-f', 'hls', '-hls_time', '2',
  '-hls_list_size', '0', '-hls_segment_filename', join(mediaDir, 'segment-%02d.ts'),
  join(mediaDir, 'route.m3u8'),
], { encoding: 'utf8' });
if (generated.error || generated.status !== 0) {
  await rm(mediaDir, { recursive: true, force: true });
  throw new Error(`Install ffmpeg to run this test. ${generated.error?.message || generated.stderr}`);
}

const baseUrl = process.env.PLAYBACK_BASE_URL || 'http://127.0.0.1:3001';
let server;
try {
  if (!process.env.PLAYBACK_BASE_URL) {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '3001', '--strictPort']);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Vite did not start within 15 seconds')), 15000);
      server.stdout.on('data', data => {
        if (data.toString().includes('Local:')) { clearTimeout(timer); resolve(); }
      });
      server.once('exit', code => { clearTimeout(timer); reject(new Error(`Vite exited with code ${code}`)); });
      server.once('error', reject);
    });
  }

  const start = Date.UTC(2026, 0, 1, 12);
  const publicRoute = {
    fullname: '5beb9b58bd12b691|0000010a--a51155e496', create_time: start,
    start_time_utc_millis: start, end_time_utc_millis: start + 12000,
    segment_numbers: [0], segment_start_times: [start], segment_end_times: [start + 12000],
    url: `${baseUrl}/fixture`, distance: 0.1, maxqlog: 0,
    share_exp: 'test', share_sig: 'test',
  };
  const engines = [
    { name: 'Chromium', engine: chromium, options: {}, executablePath: process.env.PLAYBACK_CHROMIUM_EXECUTABLE },
    { name: 'Firefox', engine: firefox, options: {} },
    { name: 'iPhone WebKit', engine: webkit, options: devices['iPhone 13'], executablePath: process.env.PLAYBACK_WEBKIT_EXECUTABLE },
  ];
  for (const { name, engine, options, executablePath } of engines) {
    const browser = await engine.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let failManifest = false;
      let failFirstSegment = false;
      await page.route('https://api.comma.ai/**', async request => {
        const url = new URL(request.request().url());
        if (url.pathname.endsWith('qcamera.m3u8')) {
          await request.fulfill({ status: failManifest ? 404 : 200, contentType: 'application/vnd.apple.mpegurl',
            body: failManifest ? 'Missing video' : await readFile(join(mediaDir, 'route.m3u8')) });
        } else if (/segment-\d+\.ts$/.test(url.pathname)) {
          await request.fulfill({ status: failFirstSegment && url.pathname.endsWith('segment-00.ts') ? 404 : 200,
            contentType: 'video/mp2t', body: await readFile(join(mediaDir, url.pathname.split('/').pop())) });
        } else {
          await request.fulfill({ json: url.pathname.endsWith('routes_segments') ? [publicRoute] : [] });
        }
      });
      await page.route(`${baseUrl}/fixture/**`, request => request.fulfill({ json: [] }));
      await page.route('https://api.mapbox.com/**', request => request.fulfill({ json: { version: 8, sources: {}, layers: [] } }));
      await page.goto(`${baseUrl}/demo`);
      await page.getByText('Missing qlog', { exact: true }).click();
      const video = page.getByLabel('Drive video');
      await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.1);
      await page.waitForFunction(() => !document.querySelector('[aria-label="Unmute"]')?.disabled);
      await page.getByRole('button', { name: 'Unmute', exact: true }).click();
      assert.equal(await video.evaluate(element => element.muted), false);
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('video').paused);
      await page.getByRole('button', { name: 'Jump forward 10 seconds' }).click();
      await page.waitForFunction(() => document.querySelector('video').currentTime >= 9.9 && !document.querySelector('video').seeking);
      assert.equal(await video.evaluate(element => element.paused), true);
      await page.getByRole('button', { name: 'Jump back 10 seconds' }).click();
      await page.getByRole('button', { name: 'Unpause', exact: true }).click();
      await video.evaluate(element => { element.dataset.identity = 'original'; });
      await page.getByText('Map', { exact: true }).click();
      assert.equal(await video.getAttribute('data-identity'), 'original');
      assert.equal(await video.evaluate(element => element.muted), false);
      await page.waitForFunction(() => document.querySelector('video').currentTime > 0.1 && !document.querySelector('video').paused);
      await page.getByText('Video', { exact: true }).click();
      assert.equal(await video.getAttribute('data-identity'), 'original');

      // Exercise the same actions dispatched by a timeline selection. Use a
      // short range so the test observes a real loop without waiting 12 seconds.
      await page.evaluate(async () => {
        const { default: store } = await import('/src/store.js');
        const { selectLoop, seek } = await import('/src/timeline/playback.js');
        store.dispatch(selectLoop(0, 2000));
        store.dispatch(seek(1800));
      });
      await page.waitForFunction(() => document.querySelector('video').currentTime < 0.5 && !document.querySelector('video').paused);
      const timing = await page.evaluate(async () => {
        const { currentOffset } = await import('/src/timeline/index.js');
        return { offset: currentOffset(), media: document.querySelector('video').currentTime * 1000 };
      });
      assert.ok(Math.abs(timing.offset - timing.media) < 20);
      console.log(`${name}: playback, audio, paused seeking, map switching and selection looping passed`);

      failManifest = true;
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.getByText('Missing qcamera', { exact: true }).click();
      await page.getByRole('alert').waitFor({ timeout: 20000 });
      failManifest = false;
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.1);
      failFirstSegment = true;
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      const missingSegment = page.waitForResponse(response => response.url().endsWith('segment-00.ts') && response.status() === 404);
      await page.getByText('Missing qcamera (1 segment)', { exact: true }).click();
      await missingSegment;
      await page.evaluate(async () => {
        const { default: store } = await import('/src/store.js');
        const { seek } = await import('/src/timeline/playback.js');
        store.dispatch(seek(6000));
      });
      await page.waitForFunction(() => document.querySelector('video')?.currentTime >= 6 && !document.querySelector('video').paused);
      console.log(`${name}: seeking past a missing first segment passed`);
      assert.deepEqual(errors, []);
      console.log(`${name}: failed playlist and retry passed`);
    } finally {
      await browser.close();
    }
  }
} finally {
  server?.kill();
  await rm(mediaDir, { recursive: true, force: true });
}
