// @ts-check
import { test, expect } from '@playwright/test'

test('uploaded files appear in room and chat works (fake mode)', async ({ browser, page }) => {
  // Go to home in fake mode
  await page.goto('/?fake=1')

  // Attach two in-memory files
  const fileInput = page.locator('#file-input')
  await fileInput.setInputFiles([
    { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('hello a') },
    { name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('hello b') }
  ])

  // Wait until Rooms view shows with files and chat
  await page.waitForSelector('#view-rooms:not([hidden])')
  await page.waitForSelector('#room-files li')
  await page.waitForSelector('#chat-input')
  const items = await page.locator('#room-files li').all()
  expect(items.length).toBe(2)

  // Extract room id from URL
  const url = new URL(page.url())
  const roomId = url.searchParams.get('room')
  expect(roomId).toBeTruthy()

  // Open second page and join room in fake mode
  const page2 = await browser.newPage()
  await page2.goto(`/?fake=1&view=rooms&room=${roomId}`)
  await page2.waitForSelector('#chat-input')
  await page2.locator('#chat-input').fill('hello from p2')
  await page2.locator('#btn-chat-send').click()

  // Also send from first page and assert it appears
  await page.locator('#chat-input').fill('hello from p1')
  await page.locator('#btn-chat-send').click()
  const chatBox = page.locator('#chat-box')
  await expect(chatBox).toContainText('hello from p1')
})
