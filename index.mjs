import fs from "fs";
import { pipeline } from "stream";
import util from "util";
import os from "os";
import path from "path";

const DIRNAME = path.dirname(new URL(import.meta.url).pathname);

const RELEASES_LIST_API_URL =
  "https://api.github.com/repos/NomicFoundation/solx/releases?per_page=200";
const LIST_FILENAME = "list.json";
const TMP_DIR = os.tmpdir();

console.log("Downloading releases list");

const apiHeaders = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
};

// The token is only for the rate limit: unauthenticated shares one small budget
// across every runner on the same IP.
if (process.env.GITHUB_TOKEN) {
  apiHeaders.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
} else {
  console.warn("GITHUB_TOKEN is not set, falling back to unauthenticated API");
}

const response = await fetch(RELEASES_LIST_API_URL, { headers: apiHeaders });

if (!response.ok) {
  console.error(
    [
      `Failed to list releases: ${response.status} ${response.statusText}`,
      `  url:  ${RELEASES_LIST_API_URL}`,
      `  body: ${(await response.text()).slice(0, 500)}`,
    ].join("\n"),
  );
  process.exit(1);
}

const rawList = await response.json();

// Nightly and demo prereleases are ad-hoc builds, not compilers we distribute.
const list = rawList
  .filter(({ prerelease }) => !prerelease)
  .map(({ assets, tag_name }) => ({
    tag_name,
    assets: assets.map(({ name, browser_download_url }) => ({
      name,
      browser_download_url,
    })),
  }));

await fs.writeFileSync(
  path.join(DIRNAME, "public", LIST_FILENAME),
  JSON.stringify(list, undefined, 2),
  "utf-8",
);

const urls = list
  .map((release) => release.assets.map((asset) => asset.browser_download_url))
  .flat();

console.log(`Downloading ${urls.length} compiler assets`);

// Report every failed asset, not just whichever rejected first.
const downloads = await Promise.allSettled(
  urls.map(async (url) => {
    const filename = path.basename(url);
    await download(url, path.join(DIRNAME, "public", filename));
    console.log(filename, "downloaded");
  }),
);

const failed = downloads.filter(({ status }) => status === "rejected");

if (failed.length > 0) {
  console.error(`\n${failed.length} of ${urls.length} downloads failed:`);
  for (const { reason } of failed) {
    console.error(`  ${reason?.message ?? reason}`);
  }
  process.exit(1);
}

export async function download(url, filePath) {
  const streamPipeline = util.promisify(pipeline);

  const response = await fetch(url);

  if (response.ok) {
    const tmpFilePath = path.join(TMP_DIR, path.basename(filePath));

    await streamPipeline(response.body, fs.createWriteStream(tmpFilePath));
    fs.copyFileSync(tmpFilePath, filePath);
    return;
  }

  const body = await response.text();

  throw new Error(
    `Failed to download ${url}: ${response.status} ${response.statusText} ${body.slice(0, 200)}`,
  );
}

const readme = fs.readFileSync(path.join(DIRNAME, "README.md"), "utf-8");

fs.writeFileSync(
  path.join(DIRNAME, "public", "index.html"),
  `<pre>${readme}</pre>`,
);
