import assert from "node:assert/strict";
import { accessSync, constants, lstatSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { By, Key } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { Executor, HttpClient } from "selenium-webdriver/http/index.js";
import { waitForServer } from "selenium-webdriver/http/util.js";
import { BrowserCleanupController } from "../dist/test/browser-cleanup.js";
import {
  attachDriverOrQuit,
  attachFixtureOrClose,
  attachOwnedProcessesOrStop
} from "../dist/test/browser-startup-ownership.js";
import { spawnOwnedGeckodriver, waitForOwnedGeckodriverStatus } from "../dist/test/geckodriver-service.js";
import { withTimeout } from "../dist/test/test-helpers.js";
import { inspectBrowserSuccessScreenshot } from "../dist/test/browser-success-screenshot.js";
import { startBrowserFixture } from "./browser-fixture.mjs";

const WAIT_MS = 10_000;
const FIREFOX_SESSION_START_MS = 40_000;
const CLEANUP_MS = 5_000;
const CLEANUP_WORST_CASE_MS = CLEANUP_MS * 3;
const CLEANUP_MARGIN_MS = 5_000;
const CLEANUP_HOOK_MS = CLEANUP_WORST_CASE_MS + CLEANUP_MARGIN_MS;
const DESKTOP_TEST_TIMEOUT_MS = 125_000;
const DESKTOP_WATCHDOG_MS = 100_000;
const MOBILE_TEST_TIMEOUT_MS = 60_000;
const MOBILE_WATCHDOG_MS = 35_000;
const FAILURE_ROOT = fileURLToPath(new URL("../browser-artifacts/", import.meta.url));
const FAILURE_SCREENSHOTS = Object.freeze({
  desktop: resolve(FAILURE_ROOT, "desktop.png"),
  mobile: resolve(FAILURE_ROOT, "mobile.png")
});

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

function failureScreenshotPath(name) {
  const path = FAILURE_SCREENSHOTS[name];
  if (!path) throw new Error("BROWSER_ARTIFACT_NAME_INVALID");
  return path;
}

function safeFailureRoot({ create = false } = {}) {
  if (create) mkdirSync(FAILURE_ROOT, { recursive: true, mode: 0o700 });
  let stat;
  try { stat = lstatSync(FAILURE_ROOT); }
  catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error("BROWSER_ARTIFACT_ROOT_UNSAFE");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("BROWSER_ARTIFACT_ROOT_UNSAFE");
  return true;
}

function clearFailureScreenshot(name) {
  const path = failureScreenshotPath(name);
  if (!safeFailureRoot()) return;
  try { unlinkSync(path); }
  catch (error) { if (error?.code !== "ENOENT") throw new Error("BROWSER_ARTIFACT_RESET_FAILED"); }
  try { rmdirSync(FAILURE_ROOT); }
  catch (error) { if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw new Error("BROWSER_ARTIFACT_RESET_FAILED"); }
}

for (const name of Object.keys(FAILURE_SCREENSHOTS)) clearFailureScreenshot(name);

async function buildDriver({ mobile }, cleanup) {
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
  if (!geckodriverBinary) throw new Error("GECKODRIVER_EXECUTABLE_UNAVAILABLE");
  const service = spawnOwnedGeckodriver(geckodriverBinary);
  await attachOwnedProcessesOrStop(cleanup, service, CLEANUP_MS);
  const endpoint = await waitForOwnedGeckodriverStatus(
    service,
    (origin, timeoutMs, closed) => waitForServer(origin, timeoutMs, closed),
    WAIT_MS
  );
  const executor = new Executor(new HttpClient(endpoint.origin));
  const driver = firefox.Driver.createSession(options, executor);
  await attachDriverOrQuit(cleanup, driver, CLEANUP_MS);
  let capabilities;
  try {
    await withTimeout(driver.getSession(), "Firefox WebDriver startup", FIREFOX_SESSION_START_MS);
    capabilities = await driver.getCapabilities();
  } catch {
    throw new Error("FIREFOX_SESSION_START_FAILED");
  }
  const browserProcessId = capabilities.get("moz:processID");
  if (!Number.isSafeInteger(browserProcessId) || browserProcessId <= 0
      || !await service.owns(browserProcessId)) {
    throw new Error("FIREFOX_PROCESS_ID_UNOWNED");
  }
  try {
    await driver.manage().setTimeouts({ implicit: 0, pageLoad: WAIT_MS, script: WAIT_MS });
    await driver.manage().window().setRect(mobile ? { width: 390, height: 844, x: 0, y: 0 } : { width: 1440, height: 900, x: 0, y: 0 });
  } catch {
    throw new Error("FIREFOX_SESSION_CONFIG_FAILED");
  }
  return { driver };
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

async function setViewportWidth(driver, width, height = 844) {
  await driver.manage().window().setRect({ width, height, x: 0, y: 0 });
  await driver.wait(async () => await driver.executeScript("return innerWidth===arguments[0]", width), WAIT_MS,
    `Timed out waiting for viewport width ${width}`);
}

async function conversationStatusLayout(driver) {
  return driver.executeScript(`
    const box=node=>{const rect=node.getBoundingClientRect();return{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,
      width:rect.width,height:rect.height,centerY:rect.top+rect.height/2}};
    const metadata=document.querySelector('.conversation-meta'),subtitle=document.querySelector('#subtitle'),
      status=document.querySelector('#conversation-status'),model=status.querySelector('.conversation-status-model'),
      context=status.querySelector('.conversation-status-context'),activity=status.querySelector('.conversation-status-activity');
    const statusStyle=getComputedStyle(status),modelStyle=getComputedStyle(model),contextStyle=getComputedStyle(context);
    return{metadata:box(metadata),subtitle:box(subtitle),status:{...box(status),display:statusStyle.display,whiteSpace:statusStyle.whiteSpace},
      model:{...box(model),overflowX:modelStyle.overflowX,textOverflow:modelStyle.textOverflow,whiteSpace:modelStyle.whiteSpace,
        clientWidth:model.clientWidth,scrollWidth:model.scrollWidth},context:{...box(context),display:contextStyle.display,
        overflowX:contextStyle.overflowX,textOverflow:contextStyle.textOverflow,clientWidth:context.clientWidth,scrollWidth:context.scrollWidth,
        text:context.textContent,title:context.title},
      activity:{display:getComputedStyle(activity).display,text:activity.textContent}};
  `);
}

async function reloadAuthenticated(driver) {
  await driver.navigate().refresh();
  await visible(driver, "#app");
  await waitScript(driver, "return Boolean(document.querySelector('.session-row[data-record-id=\"fixture-1\"]'))");
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

async function settleQuickMenu(driver) {
  await driver.executeAsyncScript("const done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(done))");
}

async function waitQuickMenuState(driver, selector, open) {
  await driver.wait(async () => await driver.executeScript("return document.querySelector(arguments[0])?.open===arguments[1]", selector, open),
    WAIT_MS, `Timed out waiting for ${selector} open=${open}`);
}

async function waitQuickMenuPlacement(driver, selector, opensUp) {
  await driver.wait(async () => await driver.executeScript(
    "return document.querySelector(arguments[0])?.classList.contains('opens-up')===arguments[1]", selector, opensUp),
  WAIT_MS, `Timed out waiting for ${selector} opens-up=${opensUp}`);
}

async function quickMenuBox(driver, selector) {
  return driver.executeScript(`
    const actions=document.querySelector(arguments[0]+' .session-quick-actions'),viewport=visualViewport;
    const box=actions.getBoundingClientRect();
    return {left:box.left,top:box.top,right:box.right,bottom:box.bottom,
      viewportRight:(viewport?.offsetLeft||0)+(viewport?.width||innerWidth),
      viewportBottom:(viewport?.offsetTop||0)+(viewport?.height||innerHeight)};
  `, selector);
}

async function openQuickMenu(driver, selector) {
  const summary = await visible(driver, `${selector} summary`);
  await summary.click();
  await waitQuickMenuState(driver, selector, true);
  await settleQuickMenu(driver);
  assertInsideViewport(await quickMenuBox(driver, selector));
  return summary;
}

async function focusQuickMenuAction(driver, selector) {
  const action = await visible(driver, `${selector} .session-quick-action`);
  await driver.executeScript("arguments[0].focus()", action);
  assert.equal(await driver.executeScript("return document.activeElement===arguments[0]", action), true);
}

async function retainFailureScreenshot(driver, name, diagnostics) {
  if (!driver) { diagnostics.push("SCREENSHOT_DRIVER_UNAVAILABLE"); return; }
  let screenshot;
  try { screenshot = await withTimeout(driver.takeScreenshot(), "sanitized browser screenshot", CLEANUP_MS); }
  catch { diagnostics.push("SCREENSHOT_CAPTURE_FAILED"); return; }
  try {
    safeFailureRoot({ create: true });
    writeFileSync(failureScreenshotPath(name), screenshot, { encoding: "base64", flag: "wx", mode: 0o600 });
  } catch { diagnostics.push("SCREENSHOT_WRITE_FAILED"); }
}

async function assertSuccessScreenshot(driver, expected) {
  const state = await driver.executeAsyncScript(`
    const done=arguments[arguments.length-1],root=document.documentElement,error=document.querySelector('#error');
    root.dataset.theme='light';root.dataset.accent='default';
    Promise.resolve(document.fonts?.ready).then(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>done({
      theme:root.dataset.theme,accent:root.dataset.accent,errorHidden:error.hidden,
      appVisible:getComputedStyle(document.querySelector('#app')).display!=='none',width:innerWidth,height:innerHeight
    }))));
  `);
  assert.deepEqual({ theme: state.theme, accent: state.accent, errorHidden: state.errorHidden, appVisible: state.appVisible },
    { theme: "light", accent: "default", errorHidden: true, appVisible: true });
  assert.ok(state.width >= expected.minWidth && state.width <= expected.maxWidth, JSON.stringify(state));
  assert.ok(state.height >= expected.minHeight && state.height <= expected.maxHeight, JSON.stringify(state));
  const encoded = await withTimeout(driver.takeScreenshot(), "sanitized browser success screenshot", CLEANUP_MS);
  const result = await inspectBrowserSuccessScreenshot(encoded, { width: state.width, height: state.height });
  assert.ok(result.uniqueColors >= 16); assert.ok(result.entropy >= 0.25);
}

function asError(error) {
  return error instanceof Error ? error : new Error("Browser scenario rejected with a non-Error value");
}

function reportDiagnostics(error, name, diagnostics) {
  if (!diagnostics.length) return;
  Object.defineProperty(error, "browserDiagnostics", { configurable: true, enumerable: true, value: [...diagnostics] });
  process.stderr.write(`[browser-acceptance] ${name} diagnostics: ${diagnostics.join(",")}\n`);
}

function reportTeardownPhases(name, phases) {
  if (process.env.PANEL_BROWSER_TEARDOWN_TRACE !== "1") return;
  process.stderr.write(`[browser-acceptance] ${name} teardown: ${phases.join(",")}\n`);
}

async function scenario(t, name, options, run) {
  const diagnostics = [];
  const teardownPhases = [];
  const cleanup = new BrowserCleanupController({
    quitTimeoutMs: CLEANUP_MS,
    processStopTimeoutMs: CLEANUP_MS,
    fixtureCloseTimeoutMs: CLEANUP_MS
  });
  const startup = cleanup.beginStartup();
  let startupClosed = false;
  const closeStartup = () => {
    if (startupClosed) return;
    startupClosed = true;
    startup.close();
  };
  let cleanupReported = false;
  t.after(async () => {
    const result = await cleanup.cleanup();
    if (cleanupReported || !result.diagnostics.length) return;
    const error = new Error("Browser scenario cleanup failed after test callback");
    reportDiagnostics(error, name, result.diagnostics);
    throw error;
  }, { timeout: CLEANUP_HOOK_MS });
  cleanup.armWatchdog(options.watchdogMs);
  let fixture;
  let browser;
  let primaryError;
  try {
    clearFailureScreenshot(name);
    fixture = await startBrowserFixture();
    await attachFixtureOrClose(cleanup, fixture, CLEANUP_MS);
    browser = await buildDriver(options, cleanup);
    closeStartup();
    await run({ driver: browser.driver, fixture });
  } catch (error) {
    primaryError = asError(error);
    await retainFailureScreenshot(browser?.driver, name, diagnostics);
  } finally {
    closeStartup();
    const cleanupResult = await cleanup.cleanup();
    cleanupReported = true;
    diagnostics.push(...cleanupResult.diagnostics);
    teardownPhases.push(...cleanupResult.phases);
    reportTeardownPhases(name, teardownPhases);
    if (!primaryError && diagnostics.length) primaryError = new Error("Browser scenario cleanup failed");
    if (!primaryError) {
      try { clearFailureScreenshot(name); }
      catch { diagnostics.push("ARTIFACT_CLEANUP_FAILED"); primaryError = new Error("Browser scenario artifact cleanup failed"); }
    }
  }
  if (primaryError) { reportDiagnostics(primaryError, name, diagnostics); throw primaryError; }
}

test("desktop browser acceptance covers security and session lifecycle", {
  timeout: DESKTOP_TEST_TIMEOUT_MS,
  skip: process.platform === "linux" ? false : "Linux process supervision is required"
}, async t => {
  await scenario(t, "desktop", { mobile: false, watchdogMs: DESKTOP_WATCHDOG_MS }, async ({ driver, fixture }) => {
    assert.deepEqual(fixture.externalImages.requests, {
      allowed: { count: 0, refererPresent: false, panelCookiePresent: false },
      sameHost: { count: 0 }
    });
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
    const staticPage = await fetch(fixture.origin);
    assert.equal(staticPage.status, 200);
    assert.match(staticPage.headers.get("content-security-policy") || "", /(?:^|;)\s*img-src 'self' blob:;/);
    assert.doesNotMatch(staticPage.headers.get("content-security-policy") || "", /img-src[^;]*(?:https:|http:)/);

    await login(driver, fixture.origin);
    assert.equal((await driver.manage().getCookies()).some(cookie => cookie.name === "panel_session"), true);
    assert.equal(await driver.executeScript("return matchMedia('(hover:none), (pointer:coarse)').matches"), false);
    const appearanceMatrix = await driver.executeScript(`
      const root=document.documentElement,originalTheme=root.dataset.theme,originalAccent=root.dataset.accent;
      const themes=["system","light","dark","gruvbox-dark-hard","gruvbox-dark-medium","gruvbox-dark-soft","gruvbox-light-hard","gruvbox-light-medium","gruvbox-light-soft"];
      const accents=["default","blue","green","red","yellow","magenta","cyan"],results=[];
      for(const theme of themes)for(const accent of accents){
        root.dataset.theme=theme;root.dataset.accent=accent;
        const style=getComputedStyle(root);
        results.push({theme,accent,colorScheme:style.colorScheme,surface:style.getPropertyValue("--surface-page").trim(),
          accentColor:style.getPropertyValue("--accent").trim(),onAccent:style.getPropertyValue("--on-accent").trim()});
      }
      root.dataset.theme=originalTheme;root.dataset.accent=originalAccent;
      return results;
    `);
    assert.equal(appearanceMatrix.length, 9 * 7);
    assert.equal(appearanceMatrix.every(entry => entry.colorScheme && entry.surface && entry.accentColor && entry.onAccent), true);
    for (const theme of new Set(appearanceMatrix.map(entry => entry.theme))) {
      assert.equal(new Set(appearanceMatrix.filter(entry => entry.theme === theme).map(entry => entry.accentColor)).size, 7);
    }
    assert.equal(new Set(appearanceMatrix.map(entry => entry.surface)).size, 8);
    const preferredTheme = await driver.executeScript(
      "return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'"
    );
    for (const accent of new Set(appearanceMatrix.map(entry => entry.accent))) {
      const system = appearanceMatrix.find(entry => entry.theme === "system" && entry.accent === accent);
      const explicit = appearanceMatrix.find(entry => entry.theme === preferredTheme && entry.accent === accent);
      assert.deepEqual({ ...system, theme: preferredTheme }, explicit);
    }
    const appearanceHash = await driver.executeScript(`
      return crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(arguments[0])))
        .then(bytes=>[...new Uint8Array(bytes)].map(value=>value.toString(16).padStart(2,"0")).join(""))
    `, appearanceMatrix);
    assert.equal(new Set([
      "fa06bed07f7526d5736cff3b3e0b29a885cbde2829caab57c0922b01825078b1",
      "ee77933743a80948ff0b330a89cd79479c69eaa95debd49cce9c78df7f55acf2"
    ]).has(appearanceHash), true);
    await driver.manage().window().setRect({ width: 760, height: 844, x: 0, y: 0 });
    assert.equal(await driver.executeScript("return getComputedStyle(document.querySelector('.agents')).position"), "absolute");
    assert.deepEqual(await driver.executeScript(`
      const action=getComputedStyle(document.querySelector('.session-quick-action'));
      return {minHeight:action.minHeight,paddingTop:action.paddingTop,paddingRight:action.paddingRight,
        paddingBottom:action.paddingBottom,paddingLeft:action.paddingLeft};
    `), { minHeight: "44px", paddingTop: "8px", paddingRight: "10px", paddingBottom: "8px", paddingLeft: "10px" });
    assert.equal(await driver.executeScript(`
      const dialog=document.querySelector('#memory-candidate-dialog'),maxWidth=dialog.style.maxWidth;
      dialog.style.maxWidth='none';dialog.showModal();
      try{return getComputedStyle(dialog).width}finally{dialog.close();dialog.style.maxWidth=maxWidth}
    `), "732px");
    await driver.manage().window().setRect({ width: 761, height: 844, x: 0, y: 0 });
    assert.equal(await driver.executeScript("return getComputedStyle(document.querySelector('.agents')).position"), "static");
    await driver.manage().window().setRect({ width: 1440, height: 900, x: 0, y: 0 });
    assert.deepEqual(await driver.executeScript(`
      const conversation=getComputedStyle(document.querySelector('.conversation'));
      const composer=getComputedStyle(document.querySelector('.composer'));
      const commandNode=document.querySelector('.commands'),wasHidden=commandNode.hidden,probe=document.createElement('button');
      commandNode.append(probe);commandNode.hidden=false;
      let commands;
      try{const commandStyle=getComputedStyle(commandNode);commands={display:commandStyle.display,
        position:commandStyle.position,maxHeight:commandStyle.maxHeight,buttonDisplay:getComputedStyle(probe).display}}
      finally{probe.remove();commandNode.hidden=wasHidden}
      return {conversation:{display:conversation.display,overflow:conversation.overflow,position:conversation.position},
        composer:{display:composer.display,position:composer.position,borderRadius:composer.borderRadius},
        commands};
    `), { conversation: { display: "flex", overflow: "hidden", position: "relative" },
      composer: { display: "block", position: "relative", borderRadius: "18px" },
      commands: { display: "block", position: "absolute", maxHeight: "320px", buttonDisplay: "grid" } });
    const expandedShell = await driver.executeScript(`
      const shell=getComputedStyle(document.querySelector('.shell'));
      return {columns:shell.gridTemplateColumns.split(' ').slice(0,2),rail:getComputedStyle(document.querySelector('.sidebar-rail')).display,
        agents:getComputedStyle(document.querySelector('.agents')).display,sessions:getComputedStyle(document.querySelector('.sessions')).display};
    `);
    assert.deepEqual(expandedShell, { columns: ["90px", "310px"], rail: "none", agents: "flex", sessions: "flex" });
    const openMemory = await visible(driver, "#open-memory");
    await openMemory.click();
    await waitScript(driver, "return document.querySelector('#app').classList.contains('show-memory')");
    assert.deepEqual(await driver.executeScript(`
      const page=getComputedStyle(document.querySelector('#memory-page'));
      const navigation=getComputedStyle(document.querySelector('.memory-navigation'));
      const documentStyle=getComputedStyle(document.querySelector('.memory-document'));
      return {page:page.display,navigation:navigation.display,navigationOverflow:navigation.overflow,
        document:documentStyle.display,pressed:document.querySelector('#open-memory').getAttribute('aria-pressed')};
    `), { page: "grid", navigation: "flex", navigationOverflow: "hidden", document: "flex", pressed: "true" });
    await (await visible(driver, "#close-memory")).click();
    await waitScript(driver, "return !document.querySelector('#app').classList.contains('show-memory')");
    assert.equal(await driver.executeScript("return document.activeElement?.id"), "open-memory");
    assert.equal(await driver.executeScript(`
      const dialog=document.querySelector('#memory-candidate-dialog');dialog.showModal();
      const width=getComputedStyle(dialog).width;dialog.close();return width;
    `), "760px");
    await (await visible(driver, "#collapse-sidebar")).click();
    await waitScript(driver, "return document.querySelector('.shell').classList.contains('sidebar-collapsed')");
    assert.deepEqual(await driver.executeScript(`
      const shell=getComputedStyle(document.querySelector('.shell'));
      return {columns:shell.gridTemplateColumns.split(' ').slice(0,1),rail:getComputedStyle(document.querySelector('.sidebar-rail')).display,
        agents:getComputedStyle(document.querySelector('.agents')).display,sessions:getComputedStyle(document.querySelector('.sessions')).display};
    `), { columns: ["60px"], rail: "flex", agents: "none", sessions: "none" });
    await (await visible(driver, "#expand-sidebar")).click();
    await waitScript(driver, "return !document.querySelector('.shell').classList.contains('sidebar-collapsed')");
    assert.deepEqual(await driver.executeScript(`
      return {rail:getComputedStyle(document.querySelector('.sidebar-rail')).display,
        agents:getComputedStyle(document.querySelector('.agents')).display,sessions:getComputedStyle(document.querySelector('.sessions')).display};
    `), { rail: "none", agents: "flex", sessions: "flex" });
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
    fixture.setConversationStatus("fixture-1", {
      modelOverride: "provider/fictional-model-with-an-intentionally-long-name-for-ellipsis-verification"
    });
    await openSession(driver, "fixture-1");
    let layout = await conversationStatusLayout(driver);
    assert.equal(layout.status.whiteSpace, "nowrap");
    assert.equal(layout.model.whiteSpace, "nowrap");
    assert.equal(layout.model.overflowX, "hidden");
    assert.equal(layout.model.textOverflow, "ellipsis");
    assert.ok(layout.model.scrollWidth > layout.model.clientWidth, JSON.stringify(layout.model));
    assert.ok(Math.abs(layout.subtitle.centerY - layout.status.centerY) <= 0.5, JSON.stringify(layout));
    assert.ok(layout.context.left >= layout.status.left && layout.context.right <= layout.status.right + 0.5, JSON.stringify(layout));

    await setViewportWidth(driver, 1121);
    layout = await conversationStatusLayout(driver);
    assert.notEqual(layout.activity.display, "none");
    await setViewportWidth(driver, 1120);
    layout = await conversationStatusLayout(driver);
    assert.equal(layout.activity.display, "none");
    assert.notEqual(layout.context.display, "none");
    assert.ok(layout.context.width > 0, JSON.stringify(layout.context));
    assert.match(layout.context.title, /12,345 \/ 200,000 tokens/);
    assert.ok(layout.context.left >= layout.status.left && layout.context.right <= layout.status.right + 0.5, JSON.stringify(layout));
    await setViewportWidth(driver, 761);
    layout = await conversationStatusLayout(driver);
    assert.equal(layout.activity.display, "none");
    assert.notEqual(layout.context.display, "none");
    assert.ok(layout.context.width > 0, JSON.stringify(layout.context));
    assert.equal(layout.context.textOverflow, "ellipsis");
    assert.match(layout.context.title, /12,345 \/ 200,000 tokens/);
    assert.ok(layout.context.left >= layout.status.left && layout.context.right <= layout.status.right + 0.5, JSON.stringify(layout));
    await setViewportWidth(driver, 760);
    assert.equal((await conversationStatusLayout(driver)).status.display, "none");
    await setViewportWidth(driver, 1440, 900);

    fixture.setConversationStatus("fixture-1", { contextUsage: {
      source: "openclaw-session", totalTokens: 9500, contextTokens: 128000, totalTokensFresh: true, percentage: 7
    } });
    await openSession(driver, "fixture-1");
    await waitText(driver, "#conversation-status", "9.5k");
    await waitText(driver, "#conversation-status", "128k");
    fixture.setConversationStatus("fixture-1", { contextUsage: null });
    await openSession(driver, "fixture-1");
    await waitText(driver, "#conversation-status", "上下文未知");
    fixture.setConversationStatus("fixture-1", { contextUsage: {
      source: "openclaw-session", totalTokens: 6400, contextTokens: 64000, totalTokensFresh: false, percentage: 10
    } });
    await openSession(driver, "fixture-1");
    await waitText(driver, "#conversation-status", "上下文未知 / 64k");
    fixture.characterizeCompactionUsage("fixture-1", {
      source: "openclaw-session", totalTokens: 2100, contextTokens: 128000, totalTokensFresh: true, percentage: 2
    });
    await openSession(driver, "fixture-1");
    await waitText(driver, "#conversation-status", "2.1k");
    await waitText(driver, "#conversation-status", "128k");

    await (await visible(driver, "#open-settings")).click();
    const showStatus = await visible(driver, "#show-conversation-status");
    assert.equal(await showStatus.isSelected(), true);
    await showStatus.click();
    await waitText(driver, "#conversation-setting-status", "已保存");
    assert.equal(await driver.executeScript("return document.querySelector('#conversation-status').hidden"), true);
    await (await visible(driver, "#close-settings")).click();
    await reloadAuthenticated(driver);
    await openSession(driver, "fixture-1");
    assert.equal(await driver.executeScript("return document.querySelector('#conversation-status').hidden"), true);
    await (await visible(driver, "#open-settings")).click();
    const restoredStatus = await visible(driver, "#show-conversation-status");
    assert.equal(await restoredStatus.isSelected(), false);
    await restoredStatus.click();
    await waitText(driver, "#conversation-setting-status", "已保存");
    assert.equal(await driver.executeScript("return document.querySelector('#conversation-status').hidden"), false);
    await (await visible(driver, "#close-settings")).click();
    await reloadAuthenticated(driver);
    await openSession(driver, "fixture-1");
    assert.equal(await driver.executeScript("return document.querySelector('#conversation-status').hidden"), false);
    await assertSuccessScreenshot(driver, { minWidth: 1440, maxWidth: 1440, minHeight: 720, maxHeight: 900 });
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

    await waitScript(driver, "return document.querySelectorAll('#messages .markdown-external-image').length === 2");
    assert.deepEqual(fixture.externalImages.requests, {
      allowed: { count: 0, refererPresent: false, panelCookiePresent: false },
      sameHost: { count: 0 }
    });
    assert.equal(await driver.executeScript(`
      return [...document.querySelectorAll('#messages .markdown img')]
        .some(image => new URL(image.src).origin !== location.origin)
    `), false);
    const externalImageUi = await driver.executeScript(`
      const placeholders = [...document.querySelectorAll('#messages .markdown-external-image')];
      const links = placeholders.flatMap(node => [...node.querySelectorAll('a')]);
      return { count: placeholders.length, linkCount: links.length,
        unlinkedCount: placeholders.filter(node => !node.querySelector('a')).length,
        origins: placeholders.map(node => node.querySelector('.markdown-external-image-origin')?.textContent || ''),
        link: links[0] ? { href: links[0].href, target: links[0].target, rel: links[0].rel,
          referrerPolicy: links[0].referrerPolicy, text: links[0].textContent } : null };
    `);
    assert.deepEqual(externalImageUi, {
      count: 2,
      linkCount: 1,
      unlinkedCount: 1,
      origins: [new URL(fixture.externalImages.allowedUrl).origin, new URL(fixture.externalImages.sameHostUrl).origin],
      link: { href: fixture.externalImages.allowedUrl, target: "_blank", rel: "noopener noreferrer",
        referrerPolicy: "no-referrer", text: "打开外部图片" }
    });

    const panelHandle = await driver.getWindowHandle();
    const originalHandles = new Set(await driver.getAllWindowHandles());
    await (await visible(driver, "#messages .markdown-external-image a")).click();
    let externalHandle = "";
    await driver.wait(async () => {
      externalHandle = (await driver.getAllWindowHandles()).find(handle => !originalHandles.has(handle)) || "";
      return Boolean(externalHandle);
    }, WAIT_MS, "Timed out waiting for the explicit external-image tab");
    await driver.wait(() => fixture.externalImages.requests.allowed.count >= 1, WAIT_MS,
      "Timed out waiting for the explicit external-image navigation");
    assert.deepEqual(fixture.externalImages.requests, {
      allowed: { count: 1, refererPresent: false, panelCookiePresent: false },
      sameHost: { count: 0 }
    });
    await driver.switchTo().window(externalHandle);
    await driver.wait(async () => await driver.getCurrentUrl() === fixture.externalImages.allowedUrl, WAIT_MS,
      "Timed out waiting for the external image document");
    assert.equal(await driver.executeScript("return window.opener === null"), true);
    await driver.close();
    await driver.switchTo().window(panelHandle);
    await driver.wait(async () => {
      const handles = await driver.getAllWindowHandles();
      return handles.length === originalHandles.size && handles.every(handle => originalHandles.has(handle));
    }, WAIT_MS, "Timed out waiting for the external-image tab to close");
    assert.equal(fixture.externalImages.requests.sameHost.count, 0);

    await driver.executeScript(`
      const list=document.querySelector('#sessions .project-sessions'),template=list.querySelector('.session-row');
      for(let index=0;index<14;index++){
        const clone=template.cloneNode(true);clone.classList.remove('active');clone.dataset.recordId='menu-fixture-'+index;
        list.append(clone);
      }
    `);
    const firstQuickMenu = "#sessions .session-row:first-of-type .session-quick-menu";
    const secondQuickMenu = "#sessions .session-row:nth-of-type(6) .session-quick-menu";
    const lastQuickMenu = "#sessions .session-row:nth-of-type(12) .session-quick-menu";
    await driver.executeScript("document.querySelector(arguments[0]).scrollIntoView({block:'start'})", firstQuickMenu);
    await openQuickMenu(driver, firstQuickMenu);
    await driver.executeScript("document.querySelector(arguments[0]).scrollIntoView({block:'center'})", secondQuickMenu);
    await openQuickMenu(driver, secondQuickMenu);
    assert.equal(await driver.executeScript("return document.querySelectorAll('#sessions .session-quick-menu[open]').length"), 1);
    assert.equal(await driver.executeScript("return document.querySelector(arguments[0]).open", firstQuickMenu), false);
    const outsideClosedSummary = await visible(driver, `${secondQuickMenu} summary`);
    await (await visible(driver, "#list-title")).click();
    await waitQuickMenuState(driver, secondQuickMenu, false);
    assert.equal(await driver.executeScript("return document.activeElement === arguments[0]", outsideClosedSummary), false);
    const quickToggle = await openQuickMenu(driver, secondQuickMenu);
    await focusQuickMenuAction(driver, secondQuickMenu);
    await driver.actions({ async: true }).sendKeys(Key.ESCAPE).perform();
    await waitQuickMenuState(driver, secondQuickMenu, false);
    assert.equal(await driver.executeScript("return document.activeElement === arguments[0]", quickToggle), true);
    await driver.executeScript("document.querySelector(arguments[0]).scrollIntoView({block:'end'})", lastQuickMenu);
    await openQuickMenu(driver, lastQuickMenu);
    assert.equal(await driver.executeScript("return document.querySelector(arguments[0]).classList.contains('opens-up')", lastQuickMenu), true);
    await driver.executeScript("document.querySelector(arguments[0]).scrollIntoView({block:'start'})", lastQuickMenu);
    await waitQuickMenuPlacement(driver, lastQuickMenu, false);
    assertInsideViewport(await quickMenuBox(driver, lastQuickMenu));
    await driver.executeScript(`
      const menu=document.querySelector(arguments[0]),toggle=menu.querySelector('summary').getBoundingClientRect(),
        height=menu.querySelector('.session-quick-actions').getBoundingClientRect().height;
      menu.closest('.session-row').style.transform='translateY('+Math.max(0,innerHeight-7-height-toggle.bottom)+'px)';
      dispatchEvent(new Event('resize'));
    `, lastQuickMenu);
    await waitQuickMenuPlacement(driver, lastQuickMenu, true);
    assertInsideViewport(await quickMenuBox(driver, lastQuickMenu));
    await driver.executeScript("const menu=document.querySelector(arguments[0]);menu.closest('.session-row').style.transform='';dispatchEvent(new Event('resize'))", lastQuickMenu);
    await waitQuickMenuPlacement(driver, lastQuickMenu, false);
    await focusQuickMenuAction(driver, lastQuickMenu);
    await driver.actions({ async: true }).sendKeys(Key.ESCAPE).perform();
    await waitQuickMenuState(driver, lastQuickMenu, false);

    await openQuickMenu(driver, secondQuickMenu);
    const hiddenBySidebarSummary = await visible(driver, `${secondQuickMenu} summary`);
    const collapseSidebar = await visible(driver, "#collapse-sidebar");
    await driver.executeScript("arguments[0].focus()", collapseSidebar);
    await driver.actions({ async: true }).sendKeys(Key.ENTER).perform();
    await waitScript(driver, "return document.querySelector('.shell').classList.contains('sidebar-collapsed')");
    await waitQuickMenuState(driver, secondQuickMenu, false);
    await driver.actions({ async: true }).sendKeys(Key.ESCAPE).perform();
    assert.equal(await driver.executeScript("return document.activeElement===arguments[0]", hiddenBySidebarSummary), false);
    const expandSidebar = await visible(driver, "#expand-sidebar");
    await driver.executeScript("arguments[0].focus()", expandSidebar);
    await driver.actions({ async: true }).sendKeys(Key.ENTER).perform();
    await waitScript(driver, "return !document.querySelector('.shell').classList.contains('sidebar-collapsed')");
    assert.equal(await driver.executeScript("return document.querySelectorAll('#sessions .session-quick-menu[open]').length"), 0);

    await openQuickMenu(driver, firstQuickMenu);
    await driver.executeScript(`
      const root=document.querySelector('#sessions'),oldMenu=document.querySelector(arguments[0]);
      const observer=new MutationObserver(()=>{
        document.documentElement.dataset.quickMenuRerender=JSON.stringify({oldOpen:oldMenu.open,oldConnected:oldMenu.isConnected});
        observer.disconnect();
      });
      observer.observe(root,{childList:true});
      const search=document.querySelector('#search');search.value='虚构';search.dispatchEvent(new Event('input',{bubbles:true}));
    `, firstQuickMenu);
    await driver.wait(async () => await driver.executeScript("return !document.querySelector('[data-record-id^=menu-fixture-]')&&document.querySelectorAll('#sessions .session-row').length>0"),
      WAIT_MS, "Timed out waiting for quick-menu rerender");
    await waitScript(driver, "return document.documentElement.dataset.quickMenuRerender");
    assert.deepEqual(await driver.executeScript("return {...JSON.parse(document.documentElement.dataset.quickMenuRerender),openCount:document.querySelectorAll('#sessions .session-quick-menu[open]').length}"),
      { oldOpen: false, oldConnected: false, openCount: 0 });
    const rerenderedQuickMenu = "#sessions .session-row:first-of-type .session-quick-menu";
    const rerenderedSummary = await openQuickMenu(driver, rerenderedQuickMenu);
    await focusQuickMenuAction(driver, rerenderedQuickMenu);
    await driver.actions({ async: true }).sendKeys(Key.ESCAPE).perform();
    await waitQuickMenuState(driver, rerenderedQuickMenu, false);
    assert.equal(await driver.executeScript("return document.activeElement===arguments[0]", rerenderedSummary), true);
    await driver.executeScript("const search=document.querySelector('#search');search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));delete document.documentElement.dataset.quickMenuRerender");
    await waitScript(driver, "return !document.querySelector('#sessions .hit')");

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
    await (await visible(driver, ".stream-tool.completed summary")).click();
    await waitText(driver, ".stream-tool.completed .tool-result", "fixture-result");
    assert.deepEqual(await driver.executeScript("return [...document.querySelectorAll('.stream-preview .message-body > *')].map(node=>node.classList.contains('stream-tool')?'tool':node.textContent.trim())"), ["第一段虚构实时预览", "tool", "第二段仍为脱敏内容"]);
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

    const reloadMessage = "刷新后只恢复持久任务";
    await textarea.sendKeys(reloadMessage);
    await (await visible(driver, "#send")).click();
    await visible(driver, ".stream-preview");
    const reloadRun = [...fixture.state.runs.values()].find(run => run.recordId === createdRecordId && !["completed", "failed", "aborted"].includes(run.status));
    assert.ok(reloadRun);
    const createsBeforeReload = fixture.state.calls.generationCreates.length;
    const getsBeforeReload = fixture.state.calls.generationGets.filter(runId => runId === reloadRun.runId).length;
    await driver.navigate().refresh();
    await visible(driver, "#app");
    await driver.wait(() => fixture.state.calls.generationGets.filter(runId => runId === reloadRun.runId).length > getsBeforeReload, WAIT_MS,
      "Timed out waiting for reload recovery to query the durable run");
    assert.equal(fixture.state.calls.generationCreates.length, createsBeforeReload,
      "reload recovery must not recreate an observable durable run");
    fixture.completeRun(createdRecordId);
    await driver.wait(async () => await driver.executeScript(`
      return localStorage.getItem('ark-panel:run:v1:' + encodeURIComponent(arguments[0])) === null
    `, createdRecordId), WAIT_MS, "Timed out waiting for the recovered run to settle");
    await openSession(driver, createdRecordId);
    await waitText(driver, "#messages", `虚构 SSE 回复：${reloadMessage}`, WAIT_MS);

    await openSession(driver, "fixture-2");
    await (await visible(driver, "#message")).sendKeys("服务端已有的另一个任务");
    await (await visible(driver, "#send")).click();
    await visible(driver, ".stream-preview");
    const serverRun = [...fixture.state.runs.values()].find(run => run.recordId === "fixture-2" && !["completed", "failed", "aborted"].includes(run.status));
    assert.ok(serverRun);
    const staleRunId = "33333333-3333-4333-8333-333333333333";
    await driver.executeScript(`
      localStorage.setItem('ark-panel:run:v1:' + encodeURIComponent(arguments[0]), JSON.stringify({
        runId: arguments[1], recordId: arguments[0], status: 'accepted', createPhase: 'provisional',
        submittedDraft: '不得绑定到服务端任务', submittedAttachmentIds: [], submittedRequestOutputs: false
      }));
    `, "fixture-2", staleRunId);
    const createsBeforeActiveRecovery = fixture.state.calls.generationCreates.length;
    await driver.navigate().refresh();
    await visible(driver, "#app");
    await driver.wait(() => fixture.state.calls.generationGets.includes(staleRunId), WAIT_MS,
      "Timed out waiting for the stale persisted run lookup");
    const recoveredServerRun = await driver.wait(async () => {
      const value = await driver.executeScript(`
        return JSON.parse(localStorage.getItem('ark-panel:run:v1:' + encodeURIComponent(arguments[0])) || 'null')
      `, "fixture-2");
      return value?.runId === serverRun.runId ? value : false;
    }, WAIT_MS, "Timed out waiting for active-other recovery");
    assert.equal(fixture.state.calls.generationCreates.length, createsBeforeActiveRecovery);
    assert.equal(recoveredServerRun.createPhase, "acknowledged");
    assert.equal(Object.hasOwn(recoveredServerRun, "submittedDraft"), false,
      "a different active run must not inherit the stale submitted payload");
    fixture.completeRun("fixture-2");
    await driver.wait(async () => await driver.executeScript(`
      return localStorage.getItem('ark-panel:run:v1:' + encodeURIComponent(arguments[0])) === null
    `, "fixture-2"), WAIT_MS, "Timed out waiting for the active-other run to settle");

    const provisionalRunId = "44444444-4444-4444-8444-444444444444";
    await driver.executeScript(`
      localStorage.setItem('ark-panel:run:v1:' + encodeURIComponent(arguments[0]), JSON.stringify({
        runId: arguments[1], recordId: arguments[0], status: 'accepted', createPhase: 'provisional',
        submittedDraft: '仅缺失时补建的任务', submittedAttachmentIds: [], submittedRequestOutputs: false
      }));
    `, "fixture-2", provisionalRunId);
    const createsBeforeProvisional = fixture.state.calls.generationCreates.length;
    const requestsBeforeProvisional = fixture.state.calls.generationRequests.length;
    await driver.navigate().refresh();
    await visible(driver, "#app");
    await driver.wait(() => fixture.state.calls.generationCreates.some(call => call.runId === provisionalRunId), WAIT_MS,
      "Timed out waiting for the confirmed-missing provisional create");
    assert.equal(fixture.state.calls.generationCreates.length, createsBeforeProvisional + 1);
    assert.deepEqual(fixture.state.calls.generationRequests.slice(requestsBeforeProvisional, requestsBeforeProvisional + 3), [
      { method: "GET_RUN", runId: provisionalRunId },
      { method: "GET_ACTIVE", recordId: "fixture-2" },
      { method: "POST", recordId: "fixture-2", runId: provisionalRunId }
    ]);
    const acknowledgedProvisional = await driver.executeScript(`
      return JSON.parse(localStorage.getItem('ark-panel:run:v1:' + encodeURIComponent(arguments[0])) || 'null')
    `, "fixture-2");
    assert.equal(acknowledgedProvisional?.runId, provisionalRunId);
    assert.equal(acknowledgedProvisional?.createPhase, "acknowledged");
    fixture.completeRun("fixture-2");
    await driver.wait(async () => await driver.executeScript(`
      return localStorage.getItem('ark-panel:run:v1:' + encodeURIComponent(arguments[0])) === null
    `, "fixture-2"), WAIT_MS, "Timed out waiting for the provisional run to settle");

    const getsBeforeCorrupt = fixture.state.calls.generationGets.length;
    const createsBeforeCorrupt = fixture.state.calls.generationCreates.length;
    await driver.executeScript(`
      localStorage.setItem('ark-panel:run:v1:' + encodeURIComponent(arguments[0]), '{not-json');
    `, "fixture-2");
    await driver.navigate().refresh();
    await visible(driver, "#app");
    await waitScript(driver, `return localStorage.getItem('ark-panel:run:v1:' + encodeURIComponent(${JSON.stringify("fixture-2")})) === null`);
    assert.equal(fixture.state.calls.generationGets.length, getsBeforeCorrupt);
    assert.equal(fixture.state.calls.generationCreates.length, createsBeforeCorrupt);

    const duplicateRunId = "55555555-5555-4555-8555-555555555555";
    await driver.executeScript(`
      const runId = arguments[0];
      for (const recordId of ['fixture-1', 'fixture-2']) {
        localStorage.setItem('ark-panel:run:v1:' + encodeURIComponent(recordId), JSON.stringify({
          runId, recordId, status: 'accepted', createPhase: 'provisional',
          submittedDraft: '冲突记录不得恢复', submittedAttachmentIds: [], submittedRequestOutputs: false
        }));
      }
    `, duplicateRunId);
    const requestsBeforeCollision = fixture.state.calls.generationRequests.length;
    await driver.navigate().refresh();
    await visible(driver, "#app");
    await waitScript(driver, `return ['fixture-1','fixture-2'].every(recordId =>
      localStorage.getItem('ark-panel:run:v1:' + encodeURIComponent(recordId)) === null)`);
    assert.equal(fixture.state.calls.generationRequests.length, requestsBeforeCollision,
      "a duplicated stored run id must start no recovery request");
    await driver.executeScript(`
      localStorage.removeItem('ark-panel:draft:v1:' + encodeURIComponent(arguments[0]) + ':' + encodeURIComponent(arguments[1]));
    `, "fixture", "fixture-2");

    await (await visible(driver, '#agents .agent[data-id="fixture"]')).click();
    await waitScript(driver, "return !document.querySelector('.session-row.active')");
    const autoCreateFile = fixture.makeUploadFile("fictional-auto-create.txt");
    const parallelFile = fixture.makeUploadFile("fictional-parallel-draft.txt");
    const retainedFile = fixture.makeUploadFile("fictional-retained-retry.txt");
    const autoMessage = "自动建会话迁移验收";
    const autoTextarea = await visible(driver, "#message");
    await autoTextarea.sendKeys(autoMessage);
    await driver.findElement(By.css("#attachment-input")).sendKeys(autoCreateFile);
    await waitText(driver, "#pending-attachments", "fictional-auto-create.txt");
    await (await visible(driver, "#request-outputs")).click();
    fixture.gates.createPanel.arm();
    fixture.gates.generationCreate.arm();
    const createPanelCount = fixture.state.calls.createPanels.length;
    await (await visible(driver, "#send")).click();
    await driver.wait(() => fixture.state.calls.createPanels.length === createPanelCount + 1, WAIT_MS,
      "Timed out waiting for the gated new-session creation");
    assert.equal(await (await visible(driver, "#send")).isEnabled(), false);
    await driver.executeScript("document.querySelector('#composer').requestSubmit()");
    assert.equal(fixture.state.calls.createPanels.length, createPanelCount + 1);
    fixture.gates.createPanel.release();
    const generationCount = fixture.state.calls.generationCreates.length;
    await driver.wait(() => fixture.state.calls.generationCreates.length === generationCount + 1, WAIT_MS,
      "Timed out waiting for the gated generation creation");
    const autoRecordId = fixture.state.calls.generationCreates.at(-1)?.recordId;
    assert.match(autoRecordId || "", /^fixture-/);
    assert.notEqual(autoRecordId, createdRecordId);
    await driver.wait(async () => await activeRecordId(driver) === autoRecordId, WAIT_MS,
      "Timed out waiting for the automatically created session to open");
    const migrated = await driver.executeScript(`
      const [agentId, recordId] = arguments;
      return {
        draft: localStorage.getItem('ark-panel:draft:v1:' + encodeURIComponent(agentId) + ':' + encodeURIComponent(recordId)),
        newOutput: localStorage.getItem('ark-panel:request-outputs:v1:new:' + encodeURIComponent(agentId)),
        sessionOutput: localStorage.getItem('ark-panel:request-outputs:v1:session:' + encodeURIComponent(agentId) + ':' + encodeURIComponent(recordId))
      };
    `, "fixture", autoRecordId);
    assert.deepEqual(migrated, { draft: autoMessage, newOutput: null, sessionOutput: "1" });
    assert.equal(await (await visible(driver, "#request-outputs")).getAttribute("aria-pressed"), "true");
    await waitText(driver, "#pending-attachments", "fictional-auto-create.txt");
    const autoUpload = fixture.state.calls.uploads.find(call => call.recordId === autoRecordId);
    const gatedCreate = fixture.state.calls.generationCreates.at(-1);
    assert.equal(autoUpload?.fileName, "fictional-auto-create.txt");
    assert.deepEqual(gatedCreate?.attachmentIds, [autoUpload?.attachmentId]);
    assert.equal(gatedCreate?.requestOutputs, true);
    fixture.gates.generationCreate.release();
    await visible(driver, ".stream-preview");
    assert.equal(await (await visible(driver, "#request-outputs")).getAttribute("aria-pressed"), "false");

    await openSession(driver, "fixture-2");
    const parallelTextarea = await visible(driver, "#message");
    await parallelTextarea.sendKeys("另一会话的新草稿");
    await driver.findElement(By.css("#attachment-input")).sendKeys(parallelFile);
    await waitText(driver, "#pending-attachments", "fictional-parallel-draft.txt");
    fixture.completeRun(autoRecordId);
    await driver.wait(async () => await driver.executeScript(`
      return localStorage.getItem('ark-panel:run:v1:' + encodeURIComponent(arguments[0])) === null
    `, autoRecordId), WAIT_MS, "Timed out waiting for the background terminal run to settle");
    assert.equal(await parallelTextarea.getAttribute("value"), "另一会话的新草稿");
    await waitText(driver, "#pending-attachments", "fictional-parallel-draft.txt");
    assert.equal(await driver.executeScript(`
      return localStorage.getItem('ark-panel:draft:v1:fixture:' + encodeURIComponent(arguments[0]))
    `, "fixture-2"), "另一会话的新草稿");

    await openSession(driver, autoRecordId);
    const retainedTextarea = await visible(driver, "#message");
    await retainedTextarea.sendKeys("失败和停止后保留的草稿");
    await driver.findElement(By.css("#attachment-input")).sendKeys(retainedFile);
    await waitText(driver, "#pending-attachments", "fictional-retained-retry.txt");
    await (await visible(driver, "#send")).click();
    await visible(driver, ".stream-preview");
    fixture.failRun(autoRecordId);
    await waitEnabled(driver, "#message", true);
    await waitScript(driver, "return !document.querySelector('.stream-preview')");
    assert.equal(await retainedTextarea.getAttribute("value"), "失败和停止后保留的草稿");
    await waitText(driver, "#pending-attachments", "fictional-retained-retry.txt");
    const failedCreate = fixture.state.calls.generationCreates.at(-1);
    const uploadsBeforeRetry = fixture.state.calls.uploads.length;
    const createsBeforeRetry = fixture.state.calls.generationCreates.length;
    await (await visible(driver, "#retry")).click();
    await driver.wait(() => fixture.state.calls.generationCreates.length === createsBeforeRetry + 1, WAIT_MS,
      "Timed out waiting for the retained generation retry");
    assert.equal(fixture.state.calls.uploads.length, uploadsBeforeRetry);
    assert.deepEqual(fixture.state.calls.generationCreates.at(-1)?.attachmentIds, failedCreate?.attachmentIds);
    await visible(driver, ".stream-preview");
    await (await visible(driver, "#send")).click();
    await waitEnabled(driver, "#message", true);
    assert.equal(await retainedTextarea.getAttribute("value"), "失败和停止后保留的草稿");
    await waitText(driver, "#pending-attachments", "fictional-retained-retry.txt");

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
    assert.deepEqual(await driver.executeScript(`
      const layer=getComputedStyle(document.querySelector('#settings-layer'));
      const drawer=getComputedStyle(document.querySelector('#settings-drawer'));
      return {layer:layer.position,drawer:drawer.display,width:drawer.width};
    `), { layer: "fixed", drawer: "flex", width: "400px" });
    await driver.actions({ async: true }).sendKeys(Key.ESCAPE).perform();
    await waitScript(driver, "return document.querySelector('#settings-layer').hidden");
    assert.equal(await driver.executeScript("return document.activeElement?.id"), "open-settings");
    await (await visible(driver, "#open-settings")).click();
    await visible(driver, "#settings-drawer");
    await (await visible(driver, "#logout")).click();
    await visible(driver, "#login-form");
    const loggedOut = await authenticatedFetch(driver, "/api/v1/auth/session");
    assert.equal(loggedOut.status, 401);
    assert.equal(loggedOut.value.error.code, "AUTH_REQUIRED");
  });
});

test("coarse mobile browser acceptance uses touch-safe controls", {
  timeout: MOBILE_TEST_TIMEOUT_MS,
  skip: process.platform === "linux" ? false : "Linux process supervision is required"
}, async t => {
  await scenario(t, "mobile", { mobile: true, watchdogMs: MOBILE_WATCHDOG_MS }, async ({ driver, fixture }) => {
    await login(driver, fixture.origin);
    assert.equal(await driver.executeScript("return matchMedia('(hover:none), (pointer:coarse)').matches"), true);
    assert.equal(await driver.executeScript("return matchMedia('(max-width:760px)').matches"), true);
    await (await visible(driver, '#agents .agent[data-id="fixture"]')).click();
    await waitScript(driver, "return document.querySelector('#app').classList.contains('show-sessions')");
    await driver.executeScript(`
      const list=document.querySelector('#sessions .project-sessions'),template=list.querySelector('.session-row');
      for(let index=0;index<14;index++){
        const clone=template.cloneNode(true);clone.classList.remove('active');clone.dataset.recordId='mobile-menu-fixture-'+index;
        list.append(clone);
      }
    `);
    const firstQuickMenu = "#sessions .session-row:first-of-type .session-quick-menu";
    const lastQuickMenu = "#sessions .session-row:last-of-type .session-quick-menu";
    await driver.executeScript("document.querySelector(arguments[0]).scrollIntoView({block:'start'})", firstQuickMenu);
    const firstQuickToggle = await openQuickMenu(driver, firstQuickMenu);
    await driver.executeScript("document.querySelector(arguments[0]).scrollIntoView({block:'end'})", lastQuickMenu);
    await openQuickMenu(driver, lastQuickMenu);
    assert.equal(await driver.executeScript("return document.querySelectorAll('#sessions .session-quick-menu[open]').length"), 1);
    assert.equal(await driver.executeScript("return document.querySelector(arguments[0]).open", firstQuickMenu), false);
    const outsideClosedSummary = await visible(driver, `${lastQuickMenu} summary`);
    await (await visible(driver, "#list-title")).click();
    await waitQuickMenuState(driver, lastQuickMenu, false);
    assert.equal(await driver.executeScript("return document.activeElement === arguments[0]", outsideClosedSummary), false);
    await driver.executeScript("document.querySelector(arguments[0]).scrollIntoView({block:'start'})", firstQuickMenu);
    await openQuickMenu(driver, firstQuickMenu);
    await focusQuickMenuAction(driver, firstQuickMenu);
    await driver.actions({ async: true }).sendKeys(Key.ESCAPE).perform();
    await waitQuickMenuState(driver, firstQuickMenu, false);
    assert.equal(await driver.executeScript("return document.activeElement === arguments[0]", firstQuickToggle), true);
    await openQuickMenu(driver, firstQuickMenu);
    await focusQuickMenuAction(driver, firstQuickMenu);
    await driver.executeScript("history.back()");
    await waitScript(driver, "return !document.querySelector('#app').classList.contains('show-sessions')");
    await waitQuickMenuState(driver, firstQuickMenu, false);
    await driver.actions({ async: true }).sendKeys(Key.ESCAPE).perform();
    assert.equal(await driver.executeScript("return document.activeElement===arguments[0]", firstQuickToggle), false);
    await driver.executeScript("history.forward()");
    await waitScript(driver, "return document.querySelector('#app').classList.contains('show-sessions')");
    assert.equal(await driver.executeScript("return document.querySelectorAll('#sessions .session-quick-menu[open]').length"), 0);
    await openSession(driver, "fixture-1");
    await waitScript(driver, "return document.querySelector('#app').classList.contains('show-conversation')");
    assert.deepEqual(await driver.executeScript(`
      const status=document.querySelector('#conversation-status');return{hidden:status.hidden,display:getComputedStyle(status).display}
    `), { hidden: false, display: "none" });

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
    await assertSuccessScreenshot(driver, { minWidth: 320, maxWidth: 760, minHeight: 600, maxHeight: 844 });
  });
});
