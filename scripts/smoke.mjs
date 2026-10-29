import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as portServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

const binary = resolve(process.argv[2] ?? "aria2c");
const expectedPlatform = process.env.TARGET_PLATFORM ?? process.platform;
const expectedArch = process.env.TARGET_ARCH ?? process.arch;
assert.equal(process.platform, expectedPlatform, "Smoke checks must run on the target OS");
assert.equal(process.arch, expectedArch, "Smoke checks must run natively on the target architecture");
const { stdout: version } = await promisify(execFile)(binary, ["--version"], { windowsHide: true, timeout: 15_000 });
for (const feature of ["Async DNS", "BitTorrent", "Firefox3 Cookie", "GZip", "HTTPS", "Metalink", "XML-RPC", "SFTP"]) {
    assert.ok(version.includes(feature), `Missing feature: ${feature}`);
}
console.log(version.trim());
const directory = await mkdtemp(join(tmpdir(), "aria2-smoke-"));
const secret = randomBytes(24).toString("hex");
const plain = Buffer.from("aria2 portable GZip smoke check\n".repeat(4096));
const compressed = gzipSync(plain);
const ranged = Buffer.alloc(12 * 1024 * 1024);
for (let index = 0; index < ranged.length; index++) ranged[index] = index % 251;
let ranges = 0;
const server = createServer((request, response) => {
    if (request.url === "/gzip") {
        response.writeHead(200, { "Content-Encoding": "gzip", "Content-Type": "application/octet-stream", "Content-Length": compressed.length });
        response.end(compressed);
    }
    else if (request.url === "/range") {
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
        const start = match ? Number(match[1]) : 0;
        const end = match?.[2] ? Number(match[2]) : ranged.length - 1;
        if (start > end || end >= ranged.length) { response.writeHead(416); response.end(); return; }
        if (match) ranges++;
        response.writeHead(match ? 206 : 200, { "Accept-Ranges": "bytes", "Content-Length": end - start + 1,
            ...(match ? { "Content-Range": `bytes ${start}-${end}/${ranged.length}` } : {}) });
        response.end(ranged.subarray(start, end + 1));
    }
    else { response.writeHead(404); response.end(); }
});
let child, exited, log = "";
try {
    await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
    const probe = portServer();
    await new Promise((done, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", done); });
    const port = probe.address().port;
    await new Promise((done, reject) => probe.close(error => error ? reject(error) : done()));
    const cleanEnv = { ...process.env };
    for (const key of ["LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH"]) delete cleanEnv[key];
    child = spawn(binary, ["--no-conf=true", "--enable-rpc=true", "--rpc-listen-all=false", "--rpc-allow-origin-all=false",
        `--rpc-listen-port=${port}`, `--rpc-secret=${secret}`, `--stop-with-process=${process.pid}`,
        "--http-accept-gzip=true", "--console-log-level=notice", "--summary-interval=0", "--enable-color=false",
        "--file-allocation=none", "--max-concurrent-downloads=3", "--split=4", "--max-connection-per-server=4",
        "--min-split-size=1M", "--auto-file-renaming=false", "--allow-overwrite=false", "--continue=false",
        "--follow-torrent=false", "--follow-metalink=false", "--check-certificate=true",
        "--enable-dht=false", "--enable-dht6=false", "--enable-peer-exchange=false", "--bt-enable-lpd=false",
        "--all-proxy=", "--http-proxy=", "--https-proxy=", "--no-proxy=",
        "--connect-timeout=15", "--timeout=30", "--max-tries=2", "--retry-wait=1"],
    { cwd: directory, env: cleanEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", error => { exited = error.message; });
    child.on("exit", (code, signal) => { exited = `${code ?? signal}`; });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { log = (log + chunk).slice(-64 * 1024); });
    const rpc = async (method, params = [], authenticated = true) => {
        if (exited !== undefined) throw new Error(`aria2 exited: ${exited}`);
        const response = await fetch(`http://127.0.0.1:${port}/jsonrpc`, { method: "POST",
            headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(5000),
            body: JSON.stringify({ jsonrpc: "2.0", id: "smoke", method, params: authenticated ? [`token:${secret}`, ...params] : params }) });
        const value = await response.json();
        if (authenticated) { assert.ok(!value.error, JSON.stringify(value.error)); return value.result; }
        return value;
    };
    const readyDeadline = Date.now() + 15_000;
    for (;;) {
        try { await rpc("aria2.getVersion"); break; }
        catch (error) { if (Date.now() > readyDeadline || exited !== undefined) throw error; await delay(100); }
    }
    assert.ok((await rpc("aria2.getGlobalStat", [], false)).error, "Unauthenticated RPC must be rejected");
    const origin = `http://127.0.0.1:${server.address().port}`;
    const requests = [[`${origin}/gzip`, "gzip.bin", plain], [`${origin}/range`, "range.bin", ranged]];
    if (process.env.ARIA2_COMMIT) {
        assert.match(process.env.ARIA2_COMMIT, /^[a-f0-9]{40}$/);
        const url = `https://raw.githubusercontent.com/aria2/aria2/${process.env.ARIA2_COMMIT}/COPYING`;
        const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        assert.ok(response.ok, "HTTPS reference request failed");
        requests.push([url, "https.txt", Buffer.from(await response.arrayBuffer())]);
    }
    else throw new Error("Set ARIA2_COMMIT to test HTTPS against the pinned official source");
    const pending = await Promise.all(requests.map(async ([url, name, body]) => ({
        gid: await rpc("aria2.addUri", [[url], { dir: directory, out: name }]), name, body
    })));
    const deadline = Date.now() + 90_000;
    for (const item of pending) {
        for (;;) {
            const status = await rpc("aria2.tellStatus", [item.gid, ["status", "totalLength", "completedLength", "errorCode", "errorMessage"]]);
            assert.ok(!["error", "removed"].includes(status.status), JSON.stringify(status));
            if (status.status === "complete") break;
            if (Date.now() > deadline) throw new Error(`Download timed out: ${item.name}`);
            await delay(100);
        }
        const received = await readFile(join(directory, item.name));
        assert.equal(createHash("sha256").update(received).digest("hex"), createHash("sha256").update(item.body).digest("hex"));
    }
    assert.ok(ranges > 0, "The range download was not exercised");
    await rpc("aria2.shutdown");
    const exitDeadline = Date.now() + 10_000;
    while (exited === undefined && Date.now() < exitDeadline) await delay(100);
    assert.equal(exited, "0", "aria2 must shut down cleanly through RPC");
    console.log(`Passed ${process.platform}/${process.arch}: authenticated RPC, HTTP ranges, GZip, HTTPS and shutdown.`);
}
catch (error) {
    console.error(log.replaceAll(secret, "[redacted]"));
    throw error;
}
finally {
    if (child && exited === undefined) {
        child.kill();
        await Promise.race([new Promise(done => child.once("exit", done)), delay(5000)]);
    }
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    const checked = resolve(directory);
    if (dirname(checked) !== resolve(tmpdir()) || !basename(checked).startsWith("aria2-smoke-")) throw new Error("Unexpected smoke directory");
    await rm(checked, { recursive: true, force: true });
}