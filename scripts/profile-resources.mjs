import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
const sha256 = data => createHash("sha256").update(data).digest("hex");
const assetHashes = {}, runtimeHashes = {};
for (const file of (await fs.readdir("src")).filter(file => file.endsWith(".js")).sort())
  runtimeHashes[file] = sha256(await fs.readFile(`src/${file}`));
const backend = process.env.BACKEND || "swiftshader";
const browser = await chromium.launch({
  headless: true,
  ...(existsSync("/home/andre/.local/bin/google-chrome")
    ? { executablePath: "/home/andre/.local/bin/google-chrome" }
    : {}),
  args: [
    "--no-sandbox",
    "--use-gl=angle",
    `--use-angle=${backend}`,
    "--enable-unsafe-swiftshader",
    "--enable-precise-memory-info",
  ],
});
const records = [];
const session = await browser.newBrowserCDPSession();
const system = await session.send("SystemInfo.getInfo");
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
        const filename = `${asset}.${format}`;
        assetHashes[filename] ||= sha256(await fs.readFile(`public/assets/${filename}`));
        const page = await browser.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(
          `${process.env.BASE_URL || "http://localhost:4190"}/examples/profile.html?asset=${asset}&format=${format}&budget=${process.env.BUDGET || 2}&rate=${process.env.RATE || 8192}&warmup=${process.env.WARMUP || 0}`,
        );
        const record = await page.evaluate(() => window.profileDone);
        if (errors.length) throw new Error(errors.join("\n"));
        if (backend !== "swiftshader" && /swiftshader|llvmpipe|software/i.test(record.gpu.renderer))
          throw new Error(`Hardware requested but got ${record.gpu.renderer}`);
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
      environment: { backend, browser: browser.version(), gpu: system.gpu, rateKiBps: Number(process.env.RATE || 8192), resolution: [480, 360], notes: "Fresh page per run; heap excludes GPU and workers; WebGL call times are CPU submission; timer queries measure render GPU work only, excluding loader uploads outside rendering." },
      assetHashes,
      runtimeHashes,
      records,
    },
    null,
    2,
  ),
);
