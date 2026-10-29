import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const upstream = "aria2/aria2";
export const targets = ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];
export const archiveName = target => `aria2-bin-${target}.${target.startsWith("win32-") ? "zip" : "tar.gz"}`;
export const archives = [...targets.map(archiveName), "aria2-sources.tar.gz"];
export const assets = [...archives, "SHA256SUMS", "build.json"];
export const sha256 = data => createHash("sha256").update(data).digest("hex");
const stable = release => release && !release.draft && !release.prerelease && /^release-\d+\.\d+\.\d+$/.test(release.tag_name);
const recipeFiles = ["dependencies.json", ".github/workflows/build.yml", "scripts/build.sh", "scripts/inputs.py", "scripts/smoke.mjs", "scripts/release.mjs"];

export function latestStable(releases) {
    const candidates = releases.filter(stable).sort((a, b) => {
        const av = a.tag_name.slice(8).split(".").map(Number);
        const bv = b.tag_name.slice(8).split(".").map(Number);
        return bv[0] - av[0] || bv[1] - av[1] || bv[2] - av[2];
    });
    if (!candidates.length) throw new Error("No published stable aria2 release was found.");
    return candidates[0];
}

export function complete(release) {
    return assets.every(name => release.assets.some(asset => asset.name === name && asset.size > 0
        && asset.state === "uploaded" && /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")));
}

export async function listReleases(api, repository) {
    const releases = [];
    for (let page = 1; ; page++) {
        const batch = await api(`/repos/${repository}/releases?per_page=100&page=${page}`);
        releases.push(...batch);
        if (batch.length < 100) return releases;
    }
}

export function releaseTag(tag, commit, recipe) {
    return `native-aria2-${tag.slice(8)}-${commit.slice(0, 12)}-${recipe.slice(0, 12)}`;
}

export async function plan(api, { repository, tag = "", recipe }) {
    if (!/^[a-f0-9]{64}$/.test(recipe)) throw new Error("Invalid build recipe digest.");
    const latest = latestStable(await listReleases(api, upstream));
    if (tag && !/^release-\d+\.\d+\.\d+$/.test(tag)) throw new Error("aria2_tag must be a stable tag such as release-1.37.0.");
    const selected = tag ? await api(`/repos/${upstream}/releases/tags/${tag}`) : latest;
    if (!stable(selected)) throw new Error(`${tag} is not a published stable upstream release.`);
    const { sha: commit } = await api(`/repos/${upstream}/commits/${selected.tag_name}`);
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Upstream did not resolve to a commit SHA.");
    const release_tag = releaseTag(selected.tag_name, commit, recipe);
    const existing = await api(`/repos/${repository}/releases/tags/${release_tag}`);
    if (existing && !existing.draft && (existing.prerelease || !complete(existing))) {
        throw new Error(`Published release ${release_tag} is incomplete; repair the recipe instead of overwriting it.`);
    }
    return { should_build: !existing || existing.draft, upstream_tag: selected.tag_name, commit, recipe, release_tag };
}

export function validateManifests(source, files, manifests, builderCommit) {
    if (!/^release-\d+\.\d+\.\d+$/.test(source.upstream_tag ?? "") || !/^[a-f0-9]{40}$/.test(source.commit ?? "")
        || !/^[a-f0-9]{64}$/.test(source.recipe ?? "") || !/^[a-f0-9]{40}$/.test(builderCommit ?? "")
        || source.release_tag !== releaseTag(source.upstream_tag, source.commit, source.recipe)) {
        throw new Error("Invalid release source metadata.");
    }
    for (const name of archives) if (!files[name]?.length) throw new Error(`Missing or empty archive: ${name}`);
    for (const target of targets) {
        const manifest = manifests[target];
        const [platform, arch] = target.split("-");
        const name = archiveName(target);
        if (manifest?.upstream?.repository !== upstream || manifest.upstream.tag !== source.upstream_tag
            || manifest.upstream.commit !== source.commit || manifest.recipe !== source.recipe
            || manifest.builderCommit !== builderCommit || manifest.target?.platform !== platform || manifest.target.arch !== arch
            || manifest.archive?.name !== name || manifest.archive.size !== files[name].length
            || manifest.archive.sha256 !== sha256(files[name]) || !/^[a-f0-9]{64}$/.test(manifest.binary?.sha256 ?? "")) {
            throw new Error(`Source, target or archive identity mismatch: ${target}`);
        }
    }
}

export async function publish(api, repository, source, files, manifests, builderCommit, runURL) {
    validateManifests(source, files, manifests, builderCommit);
    const hashes = Object.fromEntries(archives.map(name => [name, sha256(files[name])]));
    files = {
        ...files,
        SHA256SUMS: Buffer.from(archives.map(name => `${hashes[name]}  ${name}`).join("\n")),
        "build.json": Buffer.from(JSON.stringify({
            upstream: { repository: upstream, tag: source.upstream_tag, commit: source.commit },
            recipe: source.recipe,
            builder: { repository, commit: builderCommit, run: runURL },
            targets: manifests,
            sha256: hashes
        }, null, 4))
    };
    const base = `/repos/${repository}/releases`;
    let release = await api(`${base}/tags/${source.release_tag}`);
    if (release && !release.draft) throw new Error(`Refusing to overwrite published release ${source.release_tag}.`);
    const notes = [
        `Official source: https://github.com/${upstream}/tree/${source.commit} (${source.upstream_tag}).`,
        "Windows, macOS and Linux packages are provided for x64 and ARM64. All six packages passed native extracted-archive RPC, HTTP range, GZip and HTTPS smoke checks.",
        "Windows uses WinTLS; macOS uses AppleTLS and requires macOS 13.3 or newer. Linux uses statically linked musl and OpenSSL with the operating system's CA certificates.",
        "Archives include aria2c, library distribution notices and build metadata. aria2-sources.tar.gz contains the corresponding aria2/dependency sources and build scripts.",
        "macOS binaries are ad-hoc signed. Application distribution signing and notarization belong to the consuming application.",
        `Build recipe: ${source.recipe}. Build: ${runURL}.`
    ].join("\n\n");
    if (!release) {
        release = await api(base, { method: "POST", body: {
            tag_name: source.release_tag, target_commitish: builderCommit,
            name: `aria2 ${source.upstream_tag.slice(8)} native CLI packages`, body: notes,
            draft: true, prerelease: false, make_latest: "false"
        } });
    }
    for (const asset of release.assets) {
        if (assets.includes(asset.name)) await api(`${base}/assets/${asset.id}`, { method: "DELETE" });
    }
    for (const name of assets) {
        await api(`${release.upload_url.split("{")[0]}?name=${encodeURIComponent(name)}`, { method: "POST", data: files[name] });
    }
    const uploaded = await api(`${base}/${release.id}`);
    if (!uploaded.draft || !complete(uploaded)) throw new Error("The uploaded draft is incomplete; publication was stopped.");
    for (const name of assets) {
        const asset = uploaded.assets.find(asset => asset.name === name);
        if (asset.size !== files[name].length || asset.digest !== `sha256:${sha256(files[name])}`) {
            throw new Error(`Uploaded asset verification failed: ${name}`);
        }
    }
    const latest = latestStable(await listReleases(api, upstream));
    await api(`${base}/${release.id}`, { method: "PATCH", body: {
        draft: false, prerelease: false, body: notes, make_latest: String(latest.tag_name === source.upstream_tag)
    } });
    console.log(`Published https://github.com/${repository}/releases/tag/${source.release_tag}`);
}

export async function api(path, { method = "GET", body, data } = {}) {
    const url = new URL(path, "https://api.github.com");
    if (url.protocol !== "https:" || !["api.github.com", "uploads.github.com"].includes(url.hostname)) throw new Error("Unexpected GitHub API host.");
    const response = await fetch(url, {
        method,
        headers: {
            Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "vestige-aria2-builder",
            ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
            ...(data ? { "Content-Type": "application/octet-stream" } : body ? { "Content-Type": "application/json" } : {})
        },
        body: data ?? (body ? JSON.stringify(body) : undefined),
        signal: AbortSignal.timeout(data ? 5 * 60_000 : 60_000)
    });
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok) throw new Error(`${method} ${url.pathname}: ${response.status} ${await response.text()}`);
    return response.status === 204 ? null : response.json();
}

async function main() {
    const repository = process.env.GITHUB_REPOSITORY;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("Set GITHUB_REPOSITORY to owner/repo.");
    if (process.argv[2] === "check") {
        const hash = createHash("sha256");
        for (const path of recipeFiles) hash.update(path).update("\0").update(await readFile(new URL(`../${path}`, import.meta.url))).update("\0");
        const result = await plan(api, { repository, tag: process.env.ARIA2_TAG ?? "", recipe: hash.digest("hex") });
        if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(""));
        const summary = `${result.should_build ? "Build required" : "Already published"}: ${result.upstream_tag} (${result.commit}), ${result.release_tag}`;
        console.log(summary);
        if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
    }
    else if (process.argv[2] === "publish") {
        const source = { upstream_tag: process.env.ARIA2_TAG, commit: process.env.ARIA2_COMMIT,
            recipe: process.env.BUILD_RECIPE, release_tag: process.env.RELEASE_TAG };
        const files = Object.fromEntries(await Promise.all(archives.map(async name => [name, await readFile(resolve("release", name))])));
        const manifests = Object.fromEntries(await Promise.all(targets.map(async target => [target, JSON.parse(await readFile(resolve("release", `${target}.json`), "utf8"))])));
        await publish(api, repository, source, files, manifests, process.env.GITHUB_SHA,
            `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`);
    }
    else throw new Error("Usage: node scripts/release.mjs check|publish");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}