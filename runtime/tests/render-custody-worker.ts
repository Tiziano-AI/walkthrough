import { enableBrowserGroupCustody, loadCustodiedRenderer } from "../src/render/browser-custody.ts";

const { openBrowser } = await loadCustodiedRenderer();
await enableBrowserGroupCustody();
// Test-only executable publishes its own and its helper's exact PIDs locally.
// It never starts Chromium or an application fixture.
const browser = await openBrowser("chrome", { browserExecutable: process.argv[2], chromeMode: "chrome-for-testing", logLevel: "error" });
await browser.close({ silent: true });
