import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
const browser = await chromium.launch({
  headless: true,
  ...(existsSync("/home/andre/.local/bin/google-chrome")
    ? { executablePath: "/home/andre/.local/bin/google-chrome" }
    : {}),
  args: [
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--enable-precise-memory-info",
  ],
});
const records = [];
try {
  for (const asset of (process.env.ASSETS || "BoomBox,TestInteractivity").split(
    ",",
  ))
    for (const format of (process.env.FORMATS || "pax,glb").split(","))
      for (
        let repeat = 0;
        repeat < Number(process.env.REPEATS || 3);
        repeat++
      ) {
        const page = await browser.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(
          `${process.env.BASE_URL || "http://localhost:4190"}/examples/profile.html?asset=${asset}&format=${format}&budget=${process.env.BUDGET || 2}&rate=${process.env.RATE || 8192}`,
        );
        const record = await page.evaluate(() => window.profileDone);
        if (errors.length) throw new Error(errors.join("\n"));
        records.push({ ...record, repeat });
        console.log(
          asset,
          format,
          repeat,
          Math.round(record.completeMs),
          record.counts,
        );
        await page.close();
      }
} finally {
  await browser.close();
}
await fs.mkdir("artifacts", { recursive: true });
await fs.writeFile(
  process.env.OUTPUT || "artifacts/resources.json",
  JSON.stringify(
    {
      environment:
        "Chromium headless / SwiftShader; 480x360; 8 MiB/s per stream unless RATE overrides; fresh page per run; JS heap includes application and Three.js, excludes GPU and workers; WebGL times measure submission not GPU completion",
      records,
    },
    null,
    2,
  ),
);
