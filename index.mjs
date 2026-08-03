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

// A dry run does everything a real one does except touch public/ or transfer
// asset bodies — it HEAD-checks each URL instead. That keeps it cheap enough to
// run on every PR, where downloading the whole multi-gigabyte mirror is not.
const DRY_RUN = process.argv.includes("--dry-run");

const OUTPUT_DIR = DRY_RUN
  ? fs.mkdtempSync(path.join(TMP_DIR, "mirror-dry-run-"))
  : path.join(DIRNAME, "public");

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

if (DRY_RUN) {
  const problems = [];
  const mirroredAs = new Map();

  if (list.length === 0) {
    problems.push("the releases list is empty");
  }

  for (const { tag_name, assets } of list) {
    if (!tag_name) {
      problems.push("a release has no tag_name");
    }

    if (assets.length === 0) {
      problems.push(`${tag_name} has no assets`);
    }

    for (const { name, browser_download_url } of assets) {
      if (!name || !browser_download_url) {
        problems.push(`${tag_name} has an asset with no name or no URL`);
        continue;
      }

      // Every release's assets land in one flat directory keyed by filename, so
      // two releases mirroring the same name would silently clobber each other.
      const filename = path.basename(browser_download_url);
      const claimedBy = mirroredAs.get(filename);

      if (claimedBy !== undefined) {
        problems.push(`${claimedBy} and ${tag_name} both mirror ${filename}`);
      } else {
        mirroredAs.set(filename, tag_name);
      }
    }
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} problems in the releases list:`);
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
    process.exit(1);
  }
}

await fs.writeFileSync(
  path.join(OUTPUT_DIR, LIST_FILENAME),
  JSON.stringify(list, undefined, 2),
  "utf-8",
);

const urls = list
  .map((release) => release.assets.map((asset) => asset.browser_download_url))
  .flat();

console.log(
  DRY_RUN
    ? `Checking ${urls.length} compiler asset URLs`
    : `Downloading ${urls.length} compiler assets`,
);

// Report every failed asset, not just whichever rejected first.
const results = await Promise.allSettled(
  urls.map(async (url) => {
    const filename = path.basename(url);

    if (DRY_RUN) {
      const size = await checkAvailable(url);
      console.log(filename, "available");
      return size;
    }

    await download(url, path.join(OUTPUT_DIR, filename));
    console.log(filename, "downloaded");
    return 0;
  }),
);

const failed = results.filter(({ status }) => status === "rejected");

if (failed.length > 0) {
  console.error(
    `\n${failed.length} of ${urls.length} assets ${DRY_RUN ? "are unavailable" : "failed to download"}:`,
  );
  for (const { reason } of failed) {
    console.error(`  ${reason?.message ?? reason}`);
  }
  process.exit(1);
}

// HEAD, so an unreachable asset costs one request to detect instead of a
// multi-megabyte transfer. content-length is what the mirror would store.
export async function checkAvailable(url) {
  const response = await fetch(url, { method: "HEAD" });

  if (!response.ok) {
    throw new Error(
      `Asset unavailable ${url}: ${response.status} ${response.statusText}`,
    );
  }

  return Number(response.headers.get("content-length") ?? 0);
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

fs.writeFileSync(path.join(OUTPUT_DIR, "index.html"), `<pre>${readme}</pre>`);

if (DRY_RUN) {
  const bytes = results.reduce((total, { value }) => total + value, 0);

  console.log(
    `\nDry run passed: ${list.length} releases, ${urls.length} assets, ` +
      `${(bytes / 1024 ** 3).toFixed(1)} GiB of payload.`,
  );
  console.log(`Generated ${LIST_FILENAME} and index.html in ${OUTPUT_DIR}`);
}
