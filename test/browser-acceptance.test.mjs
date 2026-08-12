import assert from "node:assert/strict";
import { accessSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Builder, By, Key } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { startBrowserFixture } from "./browser-fixture.mjs";

const WAIT_MS = 10_000;

function executable(path) {
  if (!path) return false;
  try { accessSync(path, constants.X_OK); return true; }
  catch { return false; }
}

function commandPath(name) {
  const result = spawnSync("which", [name], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function configuredExecutable(environmentName, candidates, command) {
  const configured = process.env[environmentName];
  if (configured) {
    if (!executable(configured)) throw new Error(`${environmentName} does not name an executable file`);
    return configured;
  }
  return [...candidates, commandPath(command)].find(executable) || "";
}

async function buildDriver({ mobile }) {
  const firefoxBinary = configuredExecutable("PANEL_FIREFOX_BINARY", [
    "/snap/firefox/current/usr/lib/firefox/firefox",
    "/usr/local/bin/firefox",
    "/usr/lib/firefox/firefox"
  ], "firefox");
  const geckodriverBinary = configuredExecutable("PANEL_GECKODRIVER_BINARY", ["/snap/bin/geckodriver"], "geckodriver");
  const options = new firefox.Options()
    .addArguments("-headless")
    .setPreference("ui.primaryPointerCapabilities", mobile ? 1 : 6)
    .setPreference("ui.allPointerCapabilities", mobile ? 1 : 6);
  if (firefoxBinary) options.setBinary(firefoxBinary);
  let builder = new Builder().forBrowser("firefox").setFirefoxOptions(options);
  if (geckodriverBinary) builder = builder.setFirefoxService(new firefox.ServiceBuilder(geckodriverBinary));
  const driver = await builder.build();
  await driver.manage().setTimeouts({ implicit: 0, pageLoad: WAIT_MS, script: WAIT_MS });
  await driver.manage().window().setRect(mobile ? { width: 390, height: 844, x: 0, y: 0 } : { width: 1440, height: 900, x: 0, y: 0 });
  return driver;
}

async function visible(driver, selector, timeout = WAIT_MS) {
  return driver.wait(async () => {
    const elements = await driver.findElements(By.css(selector));
    for (const element of elements) {
      try { if (await element.isDisplayed()) return element; }
      catch {}
    }
    return false;
  }, timeout, `Timed out waiting for visible ${selector}`);
}

async function waitScript(driver, script, timeout = WAIT_MS) {
  return driver.wait(async () => Boolean(await driver.executeScript(script)), timeout, `Timed out waiting for browser condition: ${script}`);
}

async function waitText(driver, selector, text, timeout = WAIT_MS) {
  await driver.wait(async () => {
    const elements = await driver.findElements(By.css(selector));
    for (const element of elements) {
      try { if ((await element.getText()).includes(text)) return true; }
      catch {}
    }
    return false;
  }, timeout, `Timed out waiting for ${selector} to contain ${text}`);
}

async function waitEnabled(driver, selector, enabled) {
  await driver.wait(async () => {
    const elements = await driver.findElements(By.css(selector));
    if (!elements.length) return false;
    try { return (await elements[0].isEnabled()) === enabled; }
    catch { return false; }
  }, WAIT_MS, `Timed out waiting for ${selector} enabled=${enabled}`);
}

async function login(driver, origin) {
  await driver.get(origin);
  const username = await visible(driver, '#login-form input[name="username"]');
  const password = await visible(driver, '#login-form input[name="password"]');
  await username.sendKeys("fixture");
  await password.sendKeys("fixture-password");
  await (await visible(driver, "#login-form button")).click();
  await visible(driver, "#app");
  await waitScript(driver, "return Boolean(document.querySelector('.session-row[data-record-id=\"fixture-1\"]'))");
  assert.equal(await driver.executeScript("return document.querySelector('#error').hidden"), true);
}

async function openSession(driver, recordId) {
  await (await visible(driver, `.session-row[data-record-id="${recordId}"] > .session`)).click();
  await driver.wait(async () => await driver.executeScript("return document.querySelector('.session-row.active')?.dataset.recordId === arguments[0]", recordId), WAIT_MS);
}

async function activeRecordId(driver) {
  return driver.executeScript("return document.querySelector('.session-row.active')?.dataset.recordId || ''");
}

async function hoverMessage(driver, selector) {
  const message = await visible(driver, selector);
  await driver.executeScript("arguments[0].scrollIntoView({ block: 'center', inline: 'nearest' })", message);
  await driver.actions({ async: true }).move({ origin: message }).perform();
  await waitScript(driver, `return Number.parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(selector)}).querySelector('.actions')).opacity) > 0`);
  return message;
}

async function clickMessageAction(driver, messageSelector, pattern) {
  const message = await hoverMessage(driver, messageSelector);
  const buttons = await message.findElements(By.css(".actions button"));
  for (const button of buttons) {
    if (pattern.test(await button.getText())) { await button.click(); return; }
  }
  throw new Error(`No message action matched ${pattern}`);
}

async function authenticatedFetch(driver, path, options = {}) {
  return driver.executeAsyncScript(`
    const [path, options, done] = arguments;
    fetch(path, options).then(async response => {
      let value = null;
      try { value = await response.json(); } catch {}
      done({ status: response.status, value, headers: Object.fromEntries(response.headers) });
    }).catch(error => done({ error: String(error) }));
  `, path, options);
}

function assertInsideViewport(box) {
  assert.ok(box.left >= 0, `left edge escaped viewport: ${JSON.stringify(box)}`);
  assert.ok(box.top >= 0, `top edge escaped viewport: ${JSON.stringify(box)}`);
  assert.ok(box.right <= box.viewportRight + 0.5, `right edge escaped viewport: ${JSON.stringify(box)}`);
  assert.ok(box.bottom <= box.viewportBottom + 0.5, `bottom edge escaped viewport: ${JSON.stringify(box)}`);
}

async function retainFailureScreenshot(driver, name) {
  if (!driver) return;
  try {
    const root = resolve(process.env.PANEL_BROWSER_ARTIFACT_DIR || "browser-artifacts");
    mkdirSync(root, { recursive: true });
    writeFileSync(resolve(root, `${name}.png`), await driver.takeScreenshot(), "base64");
  } catch {}
}

async function scenario(name, options, run) {
  const fixture = await startBrowserFixture();
  let driver;
  try {
    driver = await buildDriver(options);
    await run({ driver, fixture });
  } catch (error) {
    await retainFailureScreenshot(driver, name);
    throw error;
  } finally {
    if (driver) await driver.quit().catch(() => {});
    await fixture.close();
  }
}

test("desktop browser acceptance covers security and session lifecycle", { timeout: 60_000 }, async () => {
  await scenario("desktop", { mobile: false }, async ({ driver, fixture }) => {
    const unauthenticatedPreview = await fetch(`${fixture.origin}/api/v1/files/fixture-image/preview`);
    assert.equal(unauthenticatedPreview.status, 401);
    assert.equal((await unauthenticatedPreview.json()).error.code, "AUTH_REQUIRED");
    const rejectedOrigin = await fetch(`${fixture.origin}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.invalid" },
      body: JSON.stringify({ username: "fixture", password: "fixture-password" })
    });
    assert.equal(rejectedOrigin.status, 403);
    assert.equal((await rejectedOrigin.json()).error.code, "ORIGIN_REJECTED");

    await login(driver, fixture.origin);
    assert.equal(await driver.executeScript("return matchMedia('(hover:none), (pointer:coarse)').matches"), false);
    const rejectedCsrf = await authenticatedFetch(driver, "/api/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "invalid-fixture-token" },
      body: JSON.stringify({ agentId: "fixture", title: "should-not-exist" })
    });
    assert.equal(rejectedCsrf.status, 403);
    assert.equal(rejectedCsrf.value.error.code, "CSRF_REJECTED");

    await openSession(driver, "fixture-1");
    await waitText(driver, "#title", "脱敏浏览器验收");
    await waitText(driver, "#conversation-status", "12k");
    await waitText(driver, "#conversation-status", "200k");
    assert.equal(await driver.executeScript("return globalThis.__fixtureXss"), null);
    assert.equal(await driver.executeScript("return document.querySelectorAll('#messages script').length"), 0);
    assert.equal(await driver.executeScript("return [...document.querySelectorAll('#messages a')].some(link => link.href.startsWith('javascript:'))"), false);
    await waitText(driver, "#messages", "<script>globalThis.__fixtureXss = true</script>");
    await waitScript(driver, "return [...document.querySelectorAll('#messages .message-image img')].some(image => image.complete && image.naturalWidth === 1)");
    const imageSource = await driver.executeScript("return document.querySelector('#messages .message-image img').src");
    assert.equal(imageSource, `${fixture.origin}/api/v1/files/fixture-image/preview`);
    const preview = await authenticatedFetch(driver, "/api/v1/files/fixture-image/preview");
    assert.equal(preview.status, 200);
    assert.equal(preview.headers["cache-control"], "private, no-store");
    assert.equal(preview.headers["content-security-policy"], "default-src 'none'; sandbox");
    assert.equal(preview.headers["x-content-type-options"], "nosniff");
    const resourceOrigins = await driver.executeScript("return performance.getEntriesByType('resource').map(entry => new URL(entry.name).origin)");
    assert.deepEqual([...new Set(resourceOrigins)], [fixture.origin]);

    const quickToggle = await visible(driver, '.session-row[data-record-id="fixture-1"] .session-quick-menu summary');
    await quickToggle.click();
    await waitScript(driver, "return document.querySelector('.session-row[data-record-id=\"fixture-1\"] .session-quick-menu').open");
    const quickMenuBox = await driver.executeScript(`
      const box = document.querySelector('.session-row[data-record-id="fixture-1"] .session-quick-actions').getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, viewportRight: innerWidth, viewportBottom: innerHeight };
    `);
    assertInsideViewport(quickMenuBox);
    await quickToggle.click();

    await openSession(driver, "fixture-active");
    await waitEnabled(driver, "#message", false);
    assert.match(await (await visible(driver, "#message")).getAttribute("placeholder"), /fork/);
    await clickMessageAction(driver, ".message.user", /fork/i);
    await waitText(driver, "#title", "只读活会话示例 · fork");
    await waitEnabled(driver, "#message", true);

    await (await visible(driver, "#new-session")).click();
    await waitScript(driver, "return document.querySelector('#editor-dialog').open");
    assert.equal(await driver.executeScript("return document.activeElement?.id"), "editor-input");
    await (await visible(driver, "#editor-input")).sendKeys("新建虚构会话");
    await (await visible(driver, "#editor-submit")).click();
    await waitText(driver, "#title", "新建虚构会话");
    const createdRecordId = await activeRecordId(driver);
    assert.match(createdRecordId, /^fixture-/);
    const outputToggle = await visible(driver, "#request-outputs");
    await outputToggle.click();
    assert.equal(await outputToggle.getAttribute("aria-pressed"), "true");
    assert.equal(await outputToggle.getText(), "✓");
    const textarea = await visible(driver, "#message");
    await textarea.sendKeys("桌面键盘发送验收", Key.ENTER);
    await visible(driver, ".stream-preview");
    await waitText(driver, ".stream-preview", "第一段虚构实时预览");
    await visible(driver, ".stream-tool.started");
    await waitText(driver, ".stream-tool.started", "fixture_lookup");
    const createdRun = [...fixture.state.runs.values()].find(run => run.recordId === createdRecordId && !["completed", "failed", "aborted"].includes(run.status));
    assert.equal(createdRun?.requestOutputs, true);
    fixture.advanceRun(createdRecordId);
    await waitText(driver, ".stream-preview", "第二段仍为脱敏内容");
    await visible(driver, ".stream-tool.completed");
    fixture.completeRun(createdRecordId);
    await waitText(driver, "#messages", "虚构 SSE 回复：桌面键盘发送验收");
    await waitEnabled(driver, "#message", true);
    assert.equal(await (await visible(driver, "#request-outputs")).getAttribute("aria-pressed"), "false");
    assert.equal(await textarea.getAttribute("value"), "");

    await textarea.sendKeys("SSE 断线后终态验收");
    await (await visible(driver, "#send")).click();
    await driver.wait(() => [...fixture.state.runs.values()].some(run => run.recordId === createdRecordId && run.droppedSubscription), WAIT_MS);
    await waitText(driver, "#subtitle", "连接已断开");
    fixture.completeRun(createdRecordId);
    await waitText(driver, "#messages", "虚构 SSE 回复：SSE 断线后终态验收", WAIT_MS);
    await waitEnabled(driver, "#message", true);

    await openSession(driver, "fixture-1");
    const lockedTextarea = await visible(driver, "#message");
    await lockedTextarea.sendKeys("保持运行以验证会话级锁");
    await (await visible(driver, "#send")).click();
    await waitEnabled(driver, "#message", false);
    await openSession(driver, "fixture-2");
    await waitEnabled(driver, "#message", true);
    await openSession(driver, "fixture-1");
    await waitEnabled(driver, "#message", false);
    assert.match(await (await visible(driver, "#send")).getAttribute("aria-label"), /停止/);
    await (await visible(driver, "#send")).click();
    await waitEnabled(driver, "#message", true);
    assert.equal(await lockedTextarea.getAttribute("value"), "保持运行以验证会话级锁");

    await clickMessageAction(driver, ".message.user", /编辑/);
    await waitScript(driver, "return document.querySelector('#editor-dialog').open");
    const editor = await visible(driver, "#editor-textarea");
    await editor.clear();
    await editor.sendKeys("编辑后的虚构消息");
    await (await visible(driver, "#editor-submit")).click();
    await waitText(driver, "#title", "编辑重发分支");
    const editedRecordId = await activeRecordId(driver);
    await visible(driver, ".stream-preview");
    fixture.completeRun(editedRecordId);
    await waitText(driver, "#messages", "虚构 SSE 回复：编辑后的虚构消息");

    await (await visible(driver, "#open-settings")).click();
    await visible(driver, "#settings-drawer");
    await (await visible(driver, "#logout")).click();
    await visible(driver, "#login-form");
    const loggedOut = await authenticatedFetch(driver, "/api/v1/auth/session");
    assert.equal(loggedOut.status, 401);
    assert.equal(loggedOut.value.error.code, "AUTH_REQUIRED");
  });
});

test("coarse mobile browser acceptance uses touch-safe controls", { timeout: 40_000 }, async () => {
  await scenario("mobile", { mobile: true }, async ({ driver, fixture }) => {
    await login(driver, fixture.origin);
    assert.equal(await driver.executeScript("return matchMedia('(hover:none), (pointer:coarse)').matches"), true);
    assert.equal(await driver.executeScript("return matchMedia('(max-width:760px)').matches"), true);
    await (await visible(driver, '#agents .agent[data-id="fixture"]')).click();
    await waitScript(driver, "return document.querySelector('#app').classList.contains('show-sessions')");
    await openSession(driver, "fixture-1");
    await waitScript(driver, "return document.querySelector('#app').classList.contains('show-conversation')");

    const outputToggle = await visible(driver, "#request-outputs");
    const toggleRect = await outputToggle.getRect();
    assert.ok(toggleRect.width >= 44 && toggleRect.height >= 44);
    await outputToggle.click();
    assert.equal(await outputToggle.getAttribute("aria-pressed"), "true");
    assert.equal(await outputToggle.getText(), "✓");
    const textarea = await visible(driver, "#message");
    await textarea.sendKeys("移动端第一行", Key.ENTER, "移动端第二行");
    assert.equal(await textarea.getAttribute("value"), "移动端第一行\n移动端第二行");
    assert.equal(fixture.state.runs.size, 0);
    assert.equal(await outputToggle.getAttribute("aria-pressed"), "true");

    const actionsToggle = await visible(driver, "#session-actions-toggle");
    await actionsToggle.click();
    await waitScript(driver, "return document.querySelector('#session-actions').classList.contains('mobile-open')");
    const menuBox = await driver.executeScript(`
      const viewport = visualViewport;
      const box = document.querySelector('#session-actions').getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom,
        viewportRight: (viewport?.offsetLeft || 0) + (viewport?.width || innerWidth),
        viewportBottom: (viewport?.offsetTop || 0) + (viewport?.height || innerHeight) };
    `);
    assertInsideViewport(menuBox);
    await driver.actions({ async: true }).sendKeys(Key.ESCAPE).perform();
    await waitScript(driver, "return !document.querySelector('#session-actions').classList.contains('mobile-open')");
    assert.equal(await driver.executeScript("return document.activeElement?.id"), "session-actions-toggle");

    await (await visible(driver, "#send")).click();
    await visible(driver, ".stream-preview");
    const run = [...fixture.state.runs.values()][0];
    assert.equal(run.recordId, "fixture-1");
    assert.equal(run.requestOutputs, true);
    fixture.advanceRun("fixture-1");
    await visible(driver, ".stream-tool.completed");
    fixture.completeRun("fixture-1");
    await waitText(driver, "#messages", "虚构 SSE 回复：移动端第一行");
    await waitEnabled(driver, "#message", true);
    assert.equal(await (await visible(driver, "#request-outputs")).getAttribute("aria-pressed"), "false");
  });
});
