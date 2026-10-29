# aria2 native CLI builds

Automatic builds of the official [aria2](https://github.com/aria2/aria2) source for [Vestige](https://github.com/vestige-lixue/vestige). This repository maintains the build and distribution recipe; it does not fork aria2 or import Motrix patches.

| Platform | Architectures | Runtime requirements |
| --- | --- | --- |
| Windows | x64, ARM64 | Windows 10/11 system libraries and UCRT; native WinTLS |
| macOS | x64, ARM64 | macOS 13.3 or newer; system libraries and AppleTLS |
| Linux | x64, ARM64 | Linux with system CA certificates; statically linked musl/OpenSSL |

HTTP(S), FTP, SFTP, BitTorrent, Metalink, asynchronous DNS, GZip, Firefox cookie import and JSON/XML-RPC are retained. WebSocket support uses aria2's bundled wslay. Native TLS behavior follows the selected upstream release; these packages do not change TLS implementations or promise additional TLS protocol support.

## Distribution

Each release contains six `aria2-bin-<platform>-<arch>` archives, `SHA256SUMS`, `build.json` and `aria2-sources.tar.gz`. Windows archives are ZIP files; macOS/Linux archives are gzip-compressed tar files. Platform names are `win32`, `darwin` and `linux`.

Every binary archive has one directory containing `aria2c[.exe]`, `licenses/` and `build.json`. Libraries are linked statically except for operating-system libraries. The corresponding source archive includes the exact upstream Git tree, all pinned library source archives and this repository's build scripts. Preserve the notices and corresponding source distribution when redistributing the packages.

macOS binaries are ad-hoc signed. The application that embeds them is responsible for its own distribution signing and notarization.

Linux OpenSSL uses `/etc/ssl` for default certificate discovery. Install the distribution's CA certificates; on distributions with a different trust-store path, select it using `--ca-certificate`, `SSL_CERT_FILE` or `SSL_CERT_DIR`. Certificate verification stays enabled. Windows and macOS use their native certificate stores.

## Automation

The workflow checks official stable releases daily at **04:07 UTC**. An empty `aria2_tag` selects the greatest stable version; a manual run can select a published tag such as `release-1.37.0`. All targets use the same resolved upstream commit. The release identity includes that commit and a hash of the workflow, dependency lock and build scripts.

The six packages must pass their native architecture and extracted-archive checks before publication. Checks cover unintended shared-library dependencies, required features, RPC authentication, range requests, GZip, HTTPS certificate verification and clean shutdown. Verification runs on separate machines without the build tree. Upstream's full test suite is not run.

Publication first uploads a draft, verifies every asset's SHA-256 through the GitHub API, and then publishes all targets together. Partial drafts can be retried; published assets are never replaced. Older manual versions do not replace Latest. A keepalive action, shared with the macOS Whisper CLI project, records activity after 50 inactive days so scheduled checks continue.

Pushes and pull requests run only lightweight script tests. Full builds run only through the daily schedule or **Actions → Build aria2 → Run workflow**. The standard `GITHUB_TOKEN` is sufficient; no additional secrets are needed. This initial recipe requires its first six-platform CI run before any binaries can be considered verified.

## Build inputs and scripts

`dependencies.json` fixes library source versions and SHA-256 digests, the LLVM-MinGW/UCRT toolchain used to cross-compile both Windows targets, and the official multi-architecture Alpine image used for native Linux builds. macOS uses Xcode's compiler. GitHub runner images and host build-tool packages can change, so the source/recipe identity is not a claim of bit-for-bit reproducible builds. Dependency updates are reviewed changes to the lock file.

- `scripts/build.sh`: compile the pinned libraries and official aria2 CLI.
- `scripts/inputs.py`: verify input hashes, package notices/sources, inspect binary architectures and dependencies, and verify extracted packages.
- `scripts/smoke.mjs`: exercise the packaged CLI on the matching OS and architecture.
- `scripts/release.mjs`: select upstream releases and publish verified assets.

The build scripts require Bash, Python 3.12 or newer and the host tools installed by the workflow. Release selection and smoke checks require Node.js 24. To check the repository without compiling aria2:

```sh
bash -n scripts/build.sh
node --check scripts/smoke.mjs
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p '*_test.py'
```