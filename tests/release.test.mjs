import assert from "node:assert/strict";
import test from "node:test";
import { api, archives, archiveName, assets, complete, latestStable, plan, publish, releaseTag, sha256, targets } from "../scripts/release.mjs";

const repository = "example/aria2-builds";
const commit = "a".repeat(40), recipe = "b".repeat(64), builderCommit = "c".repeat(40);
const source = { upstream_tag: "release-1.37.0", commit, recipe, release_tag: releaseTag("release-1.37.0", commit, recipe) };
const stableRelease = tag => ({ tag_name: tag, draft: false, prerelease: false });
const uploadedAssets = () => assets.map((name, index) => ({ id: index + 1, name, size: 1, state: "uploaded", digest: `sha256:${"d".repeat(64)}` }));

function inputs() {
    const files = Object.fromEntries(archives.map(name => [name, Buffer.from(`archive:${name}`)]));
    const manifests = Object.fromEntries(targets.map(target => {
        const [platform, arch] = target.split("-");
        const name = archiveName(target);
        return [target, { upstream: { repository: "aria2/aria2", tag: source.upstream_tag, commit },
            recipe, builderCommit, target: { platform, arch }, binary: { sha256: "e".repeat(64) },
            archive: { name, size: files[name].length, sha256: sha256(files[name]) } }];
    }));
    return { files, manifests };
}

function server({ existing = null, latest = "release-1.37.0", corrupt = false } = {}) {
    let release = existing && structuredClone(existing);
    const calls = [];
    const base = `/repos/${repository}/releases`;
    const request = async (path, options = {}) => {
        const method = options.method ?? "GET";
        calls.push({ path, method, body: options.body });
        if (path.startsWith("/repos/aria2/aria2/releases?")) return [stableRelease(latest), stableRelease("release-1.37.0")];
        if (path.startsWith("/repos/aria2/aria2/releases/tags/")) return stableRelease(path.split("/").at(-1));
        if (path.startsWith("/repos/aria2/aria2/commits/")) return { sha: commit };
        if (path === `${base}/tags/${source.release_tag}`) return release && structuredClone(release);
        if (path.startsWith(`${base}/tags/`)) return null;
        if (path === base && method === "POST") {
            release = { ...options.body, id: 42, assets: [], upload_url: "https://uploads.github.com/repos/example/aria2-builds/releases/42/assets{?name,label}" };
            return structuredClone(release);
        }
        if (path.startsWith(`${base}/assets/`) && method === "DELETE") {
            release.assets = release.assets.filter(asset => asset.id !== Number(path.split("/").at(-1)));
            return null;
        }
        if (path.startsWith("https://uploads.github.com/") && method === "POST") {
            const name = new URL(path).searchParams.get("name");
            release.assets.push({ name, id: release.assets.length + 100, size: options.data.length, state: "uploaded",
                digest: `sha256:${corrupt && name === "build.json" ? "0".repeat(64) : sha256(options.data)}` });
            return {};
        }
        if (path === `${base}/42` && method === "GET") return structuredClone(release);
        if (path === `${base}/42` && method === "PATCH") { Object.assign(release, options.body); return structuredClone(release); }
        throw new Error(`Unexpected API request: ${method} ${path}`);
    };
    return { request, calls, release: () => release };
}

test("selects the greatest stable version numerically", () => {
    assert.equal(latestStable([stableRelease("release-1.9.0"), stableRelease("release-1.37.0"),
        { ...stableRelease("release-2.0.0"), prerelease: true }, stableRelease("continuous")]).tag_name, "release-1.37.0");
});

test("a complete published source/recipe is not rebuilt", async () => {
    const mock = server({ existing: { ...stableRelease(source.release_tag), assets: uploadedAssets() } });
    const result = await plan(mock.request, { repository, recipe });
    assert.equal(result.should_build, false);
    assert.equal(result.commit, commit);
});

test("an incomplete published release is never silently replaced", async () => {
    const mock = server({ existing: { ...stableRelease(source.release_tag), assets: uploadedAssets().slice(1) } });
    await assert.rejects(plan(mock.request, { repository, recipe }), /incomplete/);
});

test("an incomplete draft is retried; recipe changes create a different tag", async () => {
    const mock = server({ existing: { draft: true, assets: [] } });
    assert.equal((await plan(mock.request, { repository, recipe })).should_build, true);
    const changed = await plan(mock.request, { repository, recipe: "f".repeat(64) });
    assert.notEqual(changed.release_tag, source.release_tag);
});

test("only stable upstream release tags are accepted", async () => {
    const mock = server();
    await assert.rejects(plan(mock.request, { repository, recipe, tag: "master" }), /stable tag/);
});

test("publishes only after every uploaded digest is verified", async () => {
    const mock = server(), { files, manifests } = inputs();
    await publish(mock.request, repository, source, files, manifests, builderCommit, "https://github.com/example/aria2-builds/actions/runs/1");
    assert.equal(mock.release().draft, false);
    assert.equal(mock.release().make_latest, "true");
    assert.ok(complete(mock.release()));
    assert.equal(mock.calls.at(-1).method, "PATCH");
});

test("a wrong target, commit or archive stops publication before any mutation", async () => {
    for (const change of [
        manifests => { manifests["win32-arm64"].target.arch = "x64"; },
        manifests => { manifests["linux-x64"].upstream.commit = "f".repeat(40); },
        manifests => { manifests["darwin-x64"].archive.sha256 = "0".repeat(64); }
    ]) {
        const mock = server(), { files, manifests } = inputs();
        change(manifests);
        await assert.rejects(publish(mock.request, repository, source, files, manifests, builderCommit, "https://example.invalid"), /identity mismatch/);
        assert.equal(mock.calls.length, 0);
    }
});

test("corrupted uploads leave the release as a draft", async () => {
    const mock = server({ corrupt: true }), { files, manifests } = inputs();
    await assert.rejects(publish(mock.request, repository, source, files, manifests, builderCommit, "https://example.invalid"), /verification failed/);
    assert.equal(mock.release().draft, true);
    assert.ok(!mock.calls.some(call => call.method === "PATCH"));
});

test("an older manual version does not take Latest", async () => {
    const mock = server({ latest: "release-1.38.0" }), { files, manifests } = inputs();
    await publish(mock.request, repository, source, files, manifests, builderCommit, "https://example.invalid");
    assert.equal(mock.release().make_latest, "false");
});

test("published assets are never deleted or uploaded over", async () => {
    const mock = server({ existing: { ...stableRelease(source.release_tag), assets: uploadedAssets() } });
    const { files, manifests } = inputs();
    await assert.rejects(publish(mock.request, repository, source, files, manifests, builderCommit, "https://example.invalid"), /Refusing to overwrite/);
    assert.ok(mock.calls.every(call => call.method === "GET"));
});

test("draft retries replace only this builder's known assets", async () => {
    const mock = server({ existing: { id: 42, draft: true, upload_url: "https://uploads.github.com/repos/example/aria2-builds/releases/42/assets{?name,label}",
        assets: [{ id: 7, name: archives[0] }, { id: 8, name: "review-notes.txt" }] } });
    const { files, manifests } = inputs();
    await publish(mock.request, repository, source, files, manifests, builderCommit, "https://example.invalid");
    assert.ok(mock.release().assets.some(asset => asset.name === "review-notes.txt"));
    assert.equal(mock.calls.filter(call => call.method === "DELETE").length, 1);
});

test("API credentials cannot be sent to a foreign upload host", async () => {
    await assert.rejects(api("https://example.invalid/upload", { method: "POST", data: Buffer.from("x") }), /Unexpected GitHub API host/);
});