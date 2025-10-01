// @ts-check
import { test, expect } from '@playwright/test';

test.describe('File Sync', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5173');
  });

  test('host can add files and see them in room', async ({ page }) => {
    // Create a test file
    const testFile = {
      name: 'test.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('test content'),
    };

    // Upload file
    const fileInput = page.locator('#file-input');
    await fileInput.setInputFiles({
      name: testFile.name,
      mimeType: testFile.mimeType,
      buffer: testFile.buffer,
    });

    // Wait for room creation
    await page.waitForURL(/\?view=rooms&room=/);

    // Check files are visible
    const fileList = page.locator('#room-files');
    await expect(fileList).toContainText('test.txt');

    // Check console for expected logs
    const logs = [];
    page.on('console', msg => logs.push(msg.text()));

    await page.waitForTimeout(1000);

    const hasManifestLog = logs.some(log => log.includes('[Room') && log.includes('Manifest changed: 1 files'));
    expect(hasManifestLog).toBeTruthy();
  });

  test('host reload preserves files', async ({ page, context }) => {
    // Create file and room
    const testFile = {
      name: 'persist.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('persist test'),
    };

    const fileInput = page.locator('#file-input');
    await fileInput.setInputFiles({
      name: testFile.name,
      mimeType: testFile.mimeType,
      buffer: testFile.buffer,
    });

    await page.waitForURL(/\?view=rooms&room=/);
    await expect(page.locator('#room-files')).toContainText('persist.txt');

    // Get room URL
    const url = page.url();

    // Reload page
    await page.reload();
    await page.waitForURL(url);

    // Files should still be there
    await expect(page.locator('#room-files')).toContainText('persist.txt');

    // Check console for persistence load
    const logs = [];
    page.on('console', msg => logs.push(msg.text()));
    await page.waitForTimeout(500);

    const hasLoadLog = logs.some(log => log.includes('Loaded state:') && log.includes('1 files'));
    expect(hasLoadLog).toBeTruthy();
  });

  test('joiner receives files from host', async ({ browser }) => {
    // Create two contexts (two browsers)
    const hostContext = await browser.newContext();
    const joinerContext = await browser.newContext();

    const hostPage = await hostContext.newPage();
    const joinerPage = await joinerContext.newPage();

    try {
      // Host creates room with file
      await hostPage.goto('http://localhost:5173');

      const testFile = {
        name: 'shared.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('shared content'),
      };

      const fileInput = hostPage.locator('#file-input');
      await fileInput.setInputFiles({
        name: testFile.name,
        mimeType: testFile.mimeType,
        buffer: testFile.buffer,
      });

      await hostPage.waitForURL(/\?view=rooms&room=/);
      await expect(hostPage.locator('#room-files')).toContainText('shared.txt');

      // Get invite URL
      const inviteUrl = hostPage.url();

      // Joiner opens invite
      await joinerPage.goto(inviteUrl);
      await joinerPage.waitForTimeout(3000); // Allow time for sync

      // Joiner should see the file
      await expect(joinerPage.locator('#room-files')).toContainText('shared.txt', { timeout: 10000 });

      // Check joiner console for sync logs
      const joinerLogs = [];
      joinerPage.on('console', msg => joinerLogs.push(msg.text()));

      const hasSyncLog = joinerLogs.some(log =>
        log.includes('Received SYNC_RESPONSE') || log.includes('After sync: 1 files')
      );
      expect(hasSyncLog).toBeTruthy();
    } finally {
      await hostContext.close();
      await joinerContext.close();
    }
  });

  test('chat works bidirectionally', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const joinerContext = await browser.newContext();

    const hostPage = await hostContext.newPage();
    const joinerPage = await joinerContext.newPage();

    try {
      // Host creates room
      await hostPage.goto('http://localhost:5173');
      const testFile = {
        name: 'chat-test.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('test'),
      };

      await hostPage.locator('#file-input').setInputFiles({
        name: testFile.name,
        mimeType: testFile.mimeType,
        buffer: testFile.buffer,
      });

      await hostPage.waitForURL(/\?view=rooms&room=/);
      const inviteUrl = hostPage.url();

      // Joiner joins
      await joinerPage.goto(inviteUrl);
      await joinerPage.waitForTimeout(2000);

      // Host sends message
      await hostPage.locator('#chat-input').fill('hello from host');
      await hostPage.locator('#btn-chat-send').click();
      await hostPage.waitForTimeout(500);

      // Joiner should see message
      await expect(joinerPage.locator('#chat-box')).toContainText('hello from host', { timeout: 5000 });

      // Joiner sends message
      await joinerPage.locator('#chat-input').fill('hi from joiner');
      await joinerPage.locator('#btn-chat-send').click();
      await joinerPage.waitForTimeout(500);

      // Host should see message
      await expect(hostPage.locator('#chat-box')).toContainText('hi from joiner', { timeout: 5000 });
    } finally {
      await hostContext.close();
      await joinerContext.close();
    }
  });
});
