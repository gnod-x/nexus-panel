import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
const artifactRoot=process.env.E2E_ARTIFACT_ROOT||"artifacts/home-refresh";
const buildRoot=resolve(artifactRoot,"browser-build");
const shellQuote=(value:string)=>"'"+value.replace(/'/g,"'\"'\"'")+"'";
const firefox=process.env.AUDIT_BROWSER==="firefox";
const engine=firefox?"firefox":"chromium";
export default defineConfig({
 testDir:"./tests/e2e",testMatch:["audit-ui.spec.ts","home-schedule.spec.ts","home-font-settings.spec.ts"],timeout:25000,expect:{timeout:4500},fullyParallel:false,workers:1,retries:0,
 outputDir:artifactRoot+"/browser-playwright-"+engine,
 reporter:[["list"],["json",{outputFile:artifactRoot+"/browser-results-"+engine+".json"}],["html",{outputFolder:artifactRoot+"/browser-html-"+engine,open:"never"}]],
 use:{baseURL:"http://127.0.0.1:4274",trace:"retain-on-failure",screenshot:"only-on-failure"},
 projects:[{name:"browser-audit-"+engine,use:firefox?{...devices["Desktop Firefox"]}:{...devices["Desktop Chrome"],launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH||"/usr/bin/chromium"}}}],
 webServer:{command:(process.env.AUDIT_REUSE_BUILD==="true"?"":"npx vite build --outDir "+shellQuote(resolve(buildRoot,"client"))+" && npx tsc -p tsconfig.server.json --outDir "+shellQuote(buildRoot)+" && ")+"CLIENT_DIST="+shellQuote(resolve(buildRoot,"client"))+" DATABASE_PATH=:memory: NODE_ENV=production HOST=127.0.0.1 PORT=4274 TASK_DEMO_MODE=false INTEGRATION_DEMO_MODE=false node "+shellQuote(resolve(buildRoot,"server/index.js")),url:"http://127.0.0.1:4274/api/health",reuseExistingServer:false,timeout:120000},
});
