import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, copyFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import ffmpeg from 'ffmpeg-static';
import { fixture } from './helpers.js';
const exec = promisify(execFile);

for (const format of ['mp4', 'webm'])
  test(
    `a submitted page becomes an authenticated, playable ${format} of the page actions`,
    { timeout: 120000 },
    async (t) => {
      const f = await fixture({ video: true, videoFormat: format });
      const browser = await chromium.launch({
        executablePath:
          process.env.CHROME_PATH ||
          (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined),
        chromiumSandbox: true,
      });
      f.authorizeBrowser(browser);
      t.after(async () => {
        await browser.close();
        await f.close();
      });
      const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(f.url + '/demo.html');
      await page.locator('[name=first_name]').fill('Video Test');
      await page.locator('[name=last_name]').fill('Visitor');
      await page.locator('[name=email]').fill('video@example.com');
      await page.locator('[name=private_reference]').fill('SECRET-DO-NOT-CAPTURE');
      await page.locator('[name=project_type]').selectOption('Product research');
      await page.evaluate(() => {
        const box = document.createElement('section');
        box.id = 'action-proof';
        box.textContent = 'PAGE ACTION VIDEO PROOF';
        box.style.cssText = 'background:#225533;color:white;padding:20px';
        document.querySelector('.demo-form').prepend(box);
        const ignored = document.createElement('div');
        ignored.dataset.recordingIgnore = '';
        ignored.textContent = 'IGNORED-DO-NOT-CAPTURE';
        document.body.append(ignored);
      });
      await page.mouse.move(250, 400);
      await page.waitForTimeout(400);
      await page.evaluate(() => window.scrollTo(0, 500));
      await page
        .locator('[name=message]')
        .fill('Page content, scrolling and field changes are recorded.');
      const submitted = page.waitForResponse((response) =>
        response.url().endsWith('/api/track/page/finish'),
      );
      await page.getByRole('button', { name: 'Send inquiry' }).click();
      const response = await submitted;
      assert.equal(response.status(), 200);
      const id = [...f.rows.keys()][0];
      const recording = await f.store.read(id);
      assert.equal(recording.page.format, 'rrweb');
      const encoded = JSON.stringify(recording.page.events);
      assert.ok(encoded.includes('PAGE ACTION VIDEO PROOF'));
      assert.ok(!encoded.includes('SECRET-DO-NOT-CAPTURE'));
      assert.ok(!encoded.includes('IGNORED-DO-NOT-CAPTURE'));
      assert.ok(recording.page.events.some((event) => event.type === 3 && event.data.source === 3));
      let state;
      for (let attempt = 0; attempt < 120; attempt++) {
        state = await f.videos.status(id);
        if (['ready', 'failed'].includes(state.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.equal(state.status, 'ready', JSON.stringify(state));
      const file = f.videos.file(id),
        contents = await readFile(file);
      if (format === 'mp4') assert.equal(contents.subarray(4, 8).toString(), 'ftyp');
      else assert.equal(contents.subarray(0, 4).toString('hex'), '1a45dfa3');
      assert.equal(state.format, format);
      assert.ok(contents.length > 1000);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await fetch(f.url + '/api/admin/recordings/' + id + '/video')).status, 401);
      const headers = { Cookie: f.authCookie };
      const download = await fetch(f.url + '/api/admin/recordings/' + id + '/video', { headers });
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('content-type'), 'video/' + format);
      const range = await fetch(f.url + '/api/admin/recordings/' + id + '/video', {
        headers: { ...headers, Range: 'bytes=0-99' },
      });
      assert.equal(range.status, 206);
      assert.equal((await range.arrayBuffer()).byteLength, 100);
      await exec(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-']);
      await exec(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-sseof',
        '-0.4',
        '-i',
        file,
        '-frames:v',
        '1',
        '/tmp/universal-page-video-frame.png',
      ]);
      await copyFile(file, '/tmp/universal-page-actions.' + format);
      await page.goto(f.url);
      await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
      await page.getByLabel('Password', { exact: true }).fill('test-password-1234');
      await page.getByRole('button', { name: 'Log in', exact: true }).click();
      await page.locator('#legacy summary').click();
      await page.locator('#recordings a').first().click();
      await page.getByRole('tab', { name: 'Session replay' }).click();
      await page.waitForFunction(() => document.querySelector('#session-video').readyState >= 2);
      assert.ok(await page.locator('#download-video').isVisible());
      await page.evaluate(() => document.querySelector('#session-video').play());
      await page.screenshot({ path: '/tmp/universal-video-player.png' });
      // Also produce a real MP4 from a document which has never contained a form.
      await page.goto(f.url + '/page-demo.html');
      assert.equal(await page.locator('form').count(), 0);
      await page.locator('[name=page_notes]').fill('A video with no form');
      await page.locator('#change-page').click();
      await page.locator('#continue-page').click();
      await page.waitForURL('**/complete.html');
      const noFormRow = [...f.rows.values()].find((row) =>
        row.page_url.endsWith('/page-demo.html'),
      );
      assert.ok(noFormRow);
      let noFormStatus;
      for (let attempt = 0; attempt < 120; attempt++) {
        noFormStatus = await f.videos.status(noFormRow.id);
        if (['ready', 'failed'].includes(noFormStatus.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.equal(noFormStatus.status, 'ready', JSON.stringify(noFormStatus));
      await assert.rejects(f.store.read(noFormRow.id), { code: 'ENOENT' });
      await assert.rejects(f.store.read(id), { code: 'ENOENT' });
      assert.ok(
        !(await readdir(f.directory)).some(
          (name) =>
            name.endsWith('.json') || name.endsWith('.json.gz') || name.endsWith('.capture.gz'),
        ),
      );
      await exec(ffmpeg, ['-v', 'error', '-i', f.videos.file(noFormRow.id), '-f', 'null', '-']);
      await copyFile(f.videos.file(noFormRow.id), '/tmp/universal-page-no-form.' + format);
      assert.deepEqual(errors, []);
    },
  );
