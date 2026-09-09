const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const origin = process.argv[2] || "http://localhost:3114";
const output = process.argv[3] || "output/website-flow";
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    if (process.env.AUTH_BOOTSTRAP_PATH)
      await page.goto(
        fs.readFileSync(process.env.AUTH_BOOTSTRAP_PATH, "utf8").trim(),
        { waitUntil: "domcontentloaded" },
      );
    const checks = [];
    for (const width of [360, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () =>
          document.fonts.status === "loaded" &&
          document.querySelector(".lens-artwork img").naturalWidth > 0,
      );
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "page overflow at " + width,
      );
      assert.equal(
        await page.locator("video").count(),
        0,
        "video must wait for intent",
      );
      assert.equal(await page.locator("main>.studio-film").count(), 0);
      assert.equal(await page.locator(".faq-list>details").count(), 4);
      assert.equal(
        await page.locator("main .studio-button").count(),
        1,
        "one final primary action",
      );
      assert.equal(
        await page.locator(".report-view").count(),
        0,
        "coverage waits for separate view",
      );
      assert((await page.locator("#pricing").innerText()).includes("9.99"));
      assert((await page.locator("#pricing").innerText()).includes("349"));
      assert(
        (await page.locator(".price-sheet__scope").innerText()).includes("3"),
      );
      const order = await page
        .locator("main>section")
        .evaluateAll((es) => es.map((e) => e.id));
      assert.deepEqual(order, [
        "",
        "how-it-works",
        "what-you-get",
        "about",
        "pricing",
        "faq",
      ]);
      const height = await page.evaluate(
        () => document.documentElement.scrollHeight,
      );
      const visibleWords = (await page.locator("main").innerText()).split(
        /\s+/,
      ).length;
      await page.screenshot({
        path: output + "/full-" + width + ".png",
        fullPage: true,
      });
      for (let i = 0; i < 4; i++) {
        await page.locator("#process-tab-" + i).click();
        assert.equal(
          await page.locator(".assembly").getAttribute("data-phase"),
          String(i),
        );
        assert(
          (await page.locator(".process-example").innerText()).length > 30,
        );
        assert.equal(
          await page.locator(".stage-more").getAttribute("open"),
          null,
        );
      }
      await page.locator("#process-tab-3").press("Home");
      assert.equal(
        await page.locator("#process-tab-0").getAttribute("aria-selected"),
        "true",
      );
      await page.locator(".stage-more>summary").click();
      assert.equal(await page.locator(".stage-more").getAttribute("open"), "");
      const reportTrigger = page.getByRole("button", {
        name: "לפירוט הדוגמה והכיסוי",
      });
      await reportTrigger.click();
      const report = page.locator("dialog[open]");
      assert.equal(await report.locator(".report-topic").count(), 7);
      assert((await report.innerText()).includes("אי אפשר לקבוע סכום"));
      assert(
        (await report.locator(".sample-source").innerText()).includes(
          "יוני 2026",
        ),
      );
      assert(
        await report.evaluate((el) => el.scrollWidth <= el.clientWidth),
        "dialog overflow " + width,
      );
      await page.keyboard.press("Tab");
      assert(
        await page.evaluate(() =>
          document
            .querySelector("dialog[open]")
            .contains(document.activeElement),
        ),
        "modal focus escaped",
      );
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("dialog[open]").count(), 0);
      assert(
        await reportTrigger.evaluate((el) => el === document.activeElement),
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.style.overflow),
        "",
      );
      await page.locator(".pricing-details>summary").click();
      for (const price of ["99 ₪", "199 ₪", "349 ₪"])
        assert(
          (await page.locator("#price-tiers").innerText()).includes(price),
        );
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "table overflow",
      );
      for (const summary of await page
        .locator(".faq-list>details>summary")
        .all()) {
        await summary.click();
        assert(await summary.locator("..").locator("p").isVisible());
      }
      checks.push({
        width,
        height,
        visibleWords,
        process: "four stages and keyboard passed",
        report: "seven topics in dialog; Escape/focus passed",
        price: "scope/range visible; table accessible",
        faq: 4,
      });
      console.log("PASS flow width " + width);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "פתיחת תפריט" }).click();
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator(".menu-toggle").getAttribute("aria-expanded"),
      "false",
    );
    const filmTrigger = page.getByRole("button", { name: "לצפייה · 30 שניות" });
    await filmTrigger.click();
    const video = page.locator("dialog[open] video");
    assert(await video.evaluate((el) => el.paused));
    await video.evaluate((el) => el.play());
    await page.waitForFunction(
      () => document.querySelector("video").currentTime > 0.2,
    );
    await video.evaluate((el) => {
      el.pause();
      el.textTracks[0].mode = "showing";
    });
    await page.waitForFunction(
      () => document.querySelector("video").textTracks[0].cues?.length === 5,
    );
    await page
      .locator("dialog[open]")
      .screenshot({ path: output + "/video-mobile.png" });
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator("video").count(),
      0,
      "closing removes player",
    );
    assert(await filmTrigger.evaluate((el) => el === document.activeElement));
    await page.route("**/media/tivdoc-explainer.mp4", (route) => route.abort());
    await filmTrigger.click();
    await page.locator("video").evaluate((el) => el.load());
    await page.locator(".explainer-video-error").waitFor();
    await page.locator(".explainer-video-error a").click();
    assert.equal(
      await page.locator("#explainer-transcript").getAttribute("open"),
      "",
    );
    await page.getByRole("button", { name: "סגירת החלונית" }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => (document.documentElement.style.zoom = "2"));
    await page.getByRole("button", { name: "לפירוט הדוגמה והכיסוי" }).click();
    assert(
      await page
        .locator("dialog[open]")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
      "200% dialog overflow",
    );
    await page
      .locator("dialog[open]")
      .screenshot({ path: output + "/report-zoom.png" });
    await page.keyboard.press("Escape");
    await page.evaluate(() => (document.documentElement.style.zoom = ""));
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.getByRole("button", { name: "לפירוט הדוגמה והכיסוי" }).click();
    await page
      .locator("dialog[open]")
      .screenshot({ path: output + "/report-dark.png" });
    assert.equal(
      await page.evaluate(
        () =>
          document.getAnimations().filter((a) => a.playState === "running")
            .length,
      ),
      0,
    );
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      output + "/results.json",
      JSON.stringify(
        {
          origin,
          checks,
          errors,
          video:
            "intent-only, play/pause, captions, close stops playback, source-error transcript",
          accessibility:
            "modal focus and Escape, menu, 200% CSS reflow, dark/reduced motion",
        },
        null,
        2,
      ),
    );
    console.log("PASS all flow checks");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
