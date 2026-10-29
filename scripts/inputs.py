"""Download pinned inputs, inspect binaries and package independently usable CLIs."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import shlex
import struct
import subprocess
import sys
import tarfile
import time
import urllib.request
from urllib.parse import urlsplit
import zipfile

ROOT = Path(__file__).resolve().parent.parent
TARGETS = {(p, a) for p in ('win32', 'darwin', 'linux') for a in ('x64', 'arm64')}
SHA = re.compile(r'[a-f0-9]{64}')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def config():
    value = json.loads((ROOT / 'dependencies.json').read_text(encoding='utf-8'))
    for item in [*value['sources'].values(), *value['linuxRuntimeNotices'].values(), value['windowsToolchain']]:
        if not item['url'].startswith('https://') or not SHA.fullmatch(item['sha256']):
            raise ValueError('Every input requires HTTPS and a pinned SHA-256')
    if not re.fullmatch(r'alpine:[\d.]+@sha256:[a-f0-9]{64}', value['linuxImage']):
        raise ValueError('Pin the multi-architecture Alpine image digest')
    return value


def target():
    pair = (os.environ['TARGET_PLATFORM'], os.environ['TARGET_ARCH'])
    if pair not in TARGETS:
        raise ValueError(f'Unsupported target: {pair}')
    return pair


def archive_name(platform, arch):
    return f'aria2-bin-{platform}-{arch}' + ('.zip' if platform == 'win32' else '.tar.gz')


def write_json(path, value):
    path.write_text(json.dumps(value, indent=4), encoding='utf-8', newline='\n')


def download(item, directory):
    directory.mkdir(parents=True, exist_ok=True)
    name = item.get('filename', urlsplit(item['url']).path.rsplit('/', 1)[1])
    if len(safe_name(name).parts) != 1:
        raise ValueError('Download filename must be a single path component')
    path = directory / name
    if not path.exists():
        for attempt in range(3):
            try:
                request = urllib.request.Request(item['url'], headers={'User-Agent': 'vestige-aria2-builder'})
                with urllib.request.urlopen(request, timeout=120) as response:
                    data = response.read()
                if digest(data) != item['sha256']:
                    raise ValueError(f'SHA-256 mismatch: {item["url"]}')
                path.write_bytes(data)
                break
            except (OSError, TimeoutError):
                if attempt == 2:
                    raise
                time.sleep(2 ** attempt)
    if digest(path.read_bytes()) != item['sha256']:
        raise ValueError(f'SHA-256 mismatch: {path}')
    return path


def safe_name(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or '\\' in name or ':' in name:
        raise ValueError(f'Unsafe archive entry: {name}')
    return path


def extract_source(archive, destination):
    if destination.exists():
        raise ValueError(f'Use a fresh work directory: {destination}')
    with tarfile.open(archive) as bundle:
        members = bundle.getmembers()
        roots = {safe_name(member.name).parts[0] for member in members if safe_name(member.name).parts}
        if len(roots) != 1:
            raise ValueError(f'Expected a single source directory: {archive}')
        temporary = destination.with_name(destination.name + '-unpack')
        temporary.mkdir(parents=True)
        bundle.extractall(temporary, filter='data')
    (temporary / roots.pop()).rename(destination)
    temporary.rmdir()


def fetch():
    platform, arch = target()
    work = ROOT / '.work' / f'{platform}-{arch}'
    locked = config()
    for name, item in locked['sources'].items():
        print(f'Verifying {name} {item["version"]}', flush=True)
        archive = download(item, work / 'downloads')
        extract_source(archive, work / 'src' / name)
    if platform == 'win32':
        archive = download(locked['windowsToolchain'], work / 'toolchain-download')
        extract_source(archive, work / 'toolchain')
    if platform == 'linux':
        for item in locked['linuxRuntimeNotices'].values():
            download(item, work / 'runtime-notices')


def cstring(data, position):
    return data[position:data.index(b'\0', position)].decode('utf-8')


def inspect_binary(data, platform, arch):
    """Reject wrong architectures and unintended non-system dynamic dependencies."""
    result = {'platform': platform, 'arch': arch, 'sha256': digest(data)}
    if platform == 'linux':
        if data[:6] != b'\x7fELF\x02\x01':
            raise ValueError('Expected a little-endian ELF64 executable')
        machine = struct.unpack_from('<H', data, 18)[0]
        if machine != {'x64': 62, 'arm64': 183}[arch]:
            raise ValueError('Wrong ELF architecture')
        phoff = struct.unpack_from('<Q', data, 32)[0]
        phsize, count = struct.unpack_from('<HH', data, 54)
        for index in range(count):
            position = phoff + index * phsize
            kind = struct.unpack_from('<I', data, position)[0]
            if kind == 3:
                raise ValueError('Linux binary requires a dynamic loader')
            if kind == 2:
                offset = struct.unpack_from('<Q', data, position + 8)[0]
                size = struct.unpack_from('<Q', data, position + 32)[0]
                for item in range(offset, offset + size, 16):
                    tag = struct.unpack_from('<Q', data, item)[0]
                    if tag == 0:
                        break
                    if tag == 1:
                        raise ValueError('Linux binary has a DT_NEEDED shared library')
        result['linkage'] = 'static-musl'
    elif platform == 'darwin':
        if data[:4] != b'\xcf\xfa\xed\xfe':
            raise ValueError('Expected a little-endian Mach-O64 executable')
        cpu = struct.unpack_from('<I', data, 4)[0]
        if cpu != {'x64': 0x1000007, 'arm64': 0x100000c}[arch]:
            raise ValueError('Wrong Mach-O architecture')
        position, libraries = 32, []
        for _ in range(struct.unpack_from('<I', data, 16)[0]):
            command, size = struct.unpack_from('<II', data, position)
            if size < 8 or position + size > len(data):
                raise ValueError('Invalid Mach-O load command')
            if command in (0xc, 0x80000018, 0x8000001f, 0x80000023):
                offset = struct.unpack_from('<I', data, position + 8)[0]
                libraries.append(cstring(data, position + offset))
            if command in (0x24, 0x32):
                version = struct.unpack_from('<I', data, position + (12 if command == 0x32 else 8))[0]
                result['minimumMacOS'] = [version >> 16, (version >> 8) & 255, version & 255]
            position += size
        if not libraries or any(not name.startswith(('/usr/lib/', '/System/Library/')) for name in libraries):
            raise ValueError(f'Non-system macOS libraries: {libraries}')
        minimum = tuple(map(int, config()['macosDeploymentTarget'].split('.'))) + (0,)
        if 'minimumMacOS' not in result or tuple(result['minimumMacOS']) > minimum:
            raise ValueError('macOS deployment target exceeds the configured minimum')
        result['systemLibraries'] = libraries
    else:
        if data[:2] != b'MZ':
            raise ValueError('Expected a Windows PE executable')
        pe = struct.unpack_from('<I', data, 0x3c)[0]
        if data[pe:pe + 4] != b'PE\0\0':
            raise ValueError('Invalid PE signature')
        machine, count = struct.unpack_from('<HH', data, pe + 4)
        if machine != {'x64': 0x8664, 'arm64': 0xaa64}[arch]:
            raise ValueError('Wrong PE architecture')
        optional = pe + 24
        optional_size = struct.unpack_from('<H', data, pe + 20)[0]
        if struct.unpack_from('<H', data, optional)[0] != 0x20b:
            raise ValueError('Expected PE32+')
        sections = [struct.unpack_from('<IIII', data, optional + optional_size + index * 40 + 8) for index in range(count)]

        def rva_offset(address):
            for virtual_size, virtual_address, raw_size, raw_offset in sections:
                if virtual_address <= address < virtual_address + max(virtual_size, raw_size):
                    return raw_offset + address - virtual_address
            raise ValueError('PE RVA outside sections')

        libraries = []
        imports = struct.unpack_from('<I', data, optional + 112 + 8)[0]
        if imports:
            position = rva_offset(imports)
            while any(data[position:position + 20]):
                libraries.append(cstring(data, rva_offset(struct.unpack_from('<I', data, position + 12)[0])).lower())
                position += 20
        # No delayed imports are generated by this recipe; fail if that changes.
        if struct.unpack_from('<I', data, optional + 112 + 13 * 8)[0]:
            raise ValueError('Unexpected delayed DLL imports')
        system = {'advapi32.dll', 'bcrypt.dll', 'crypt32.dll', 'gdi32.dll', 'iphlpapi.dll',
                  'kernel32.dll', 'msvcrt.dll', 'ncrypt.dll', 'ntdll.dll', 'ole32.dll',
                  'secur32.dll', 'shell32.dll', 'shlwapi.dll', 'user32.dll', 'userenv.dll',
                  'ws2_32.dll', 'wsock32.dll', 'dnsapi.dll'}
        if not libraries or any(name not in system and not name.startswith('api-ms-win-') for name in libraries):
            raise ValueError(f'Unexpected Windows DLL imports: {libraries}')
        result['systemLibraries'] = libraries
    return result


def notices(source, destination, name):
    candidates = [path for path in source.iterdir() if path.is_file()
                  and re.match(r'(?i)^(copying|licen[cs]e|notice|copyright|authors)(\b|[._-])', path.name)]
    if name == 'zlib':
        candidates += [source / 'README']
    destination.mkdir(parents=True)
    for path in candidates:
        shutil.copyfile(path, destination / path.name)
    if name == 'sqlite' and not candidates:
        header = (source / 'sqlite3.h').read_text(encoding='utf-8')
        (destination / 'NOTICE.txt').write_text(header.split('*/', 1)[0] + '*/', encoding='utf-8')
    elif not candidates:
        raise ValueError(f'No distribution notices found for {name}')


def source_metadata():
    value = {key: os.environ[key] for key in ('ARIA2_TAG', 'ARIA2_COMMIT', 'BUILD_RECIPE', 'BUILDER_COMMIT')}
    if (not re.fullmatch(r'release-\d+\.\d+\.\d+', value['ARIA2_TAG'])
            or not re.fullmatch(r'[a-f0-9]{40}', value['ARIA2_COMMIT'])
            or not re.fullmatch(r'[a-f0-9]{40}', value['BUILDER_COMMIT'])
            or not SHA.fullmatch(value['BUILD_RECIPE'])):
        raise ValueError('Invalid source/build identity')
    return {'upstream': {'repository': 'aria2/aria2', 'tag': value['ARIA2_TAG'], 'commit': value['ARIA2_COMMIT']},
            'recipe': value['BUILD_RECIPE'], 'builderCommit': value['BUILDER_COMMIT']}


def package():
    platform, arch = target()
    locked = config()
    work = ROOT / '.work' / f'{platform}-{arch}'
    upstream = ROOT.parent / 'upstream'
    bundle = work / f'aria2-bin-{platform}-{arch}'
    bundle.mkdir()
    binary = 'aria2c.exe' if platform == 'win32' else 'aria2c'
    shutil.copy2(work / 'aria2-build' / 'src' / binary, bundle / binary)
    inspection = inspect_binary((bundle / binary).read_bytes(), platform, arch)
    linked = ['zlib', 'cares', 'expat', 'sqlite', 'libssh2']
    linked += ['gmp'] if platform != 'linux' else []
    linked += ['openssl'] if platform != 'win32' else []
    notices(upstream, bundle / 'licenses' / 'aria2', 'aria2')
    notices(upstream / 'deps' / 'wslay', bundle / 'licenses' / 'wslay', 'wslay')
    for name in linked:
        notices(work / 'src' / name, bundle / 'licenses' / name, name)
    if platform == 'linux':
        shutil.copytree(work / 'runtime-notices', bundle / 'licenses' / 'linux-runtime')
    if platform == 'win32':
        # LLVM-MinGW includes runtime distribution notices next to its binaries.
        destination = bundle / 'licenses' / 'llvm-mingw'
        destination.mkdir()
        count = 0
        for path in (work / 'toolchain').rglob('*'):
            if path.is_file() and re.match(r'(?i)^(license|copying|copyright)(\b|[._-])', path.name):
                output = destination / path.relative_to(work / 'toolchain')
                output.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, output)
                count += 1
        if not count:
            raise ValueError('LLVM-MinGW runtime license notices were not found')
    metadata = {**source_metadata(), 'target': {'platform': platform, 'arch': arch},
                'binary': inspection, 'dependencies': {name: locked['sources'][name] for name in linked},
                'toolchain': locked['windowsToolchain'] if platform == 'win32' else
                {'image': locked['linuxImage']} if platform == 'linux' else
                {'deploymentTarget': locked['macosDeploymentTarget']},
                'compiler': subprocess.check_output(shlex.split(os.environ.get('CC', 'cc')) + ['--version'], text=True).splitlines()[0],
                'tls': {'win32': 'WinTLS', 'darwin': 'AppleTLS', 'linux': 'OpenSSL'}[platform]}
    if platform == 'linux':
        metadata['runtimeNotices'] = locked['linuxRuntimeNotices']
        metadata['runtimePackages'] = subprocess.check_output(['apk', 'info', '-v', 'musl', 'libgcc', 'libstdc++'], text=True).splitlines()
    write_json(bundle / 'build.json', metadata)
    release = ROOT / 'release'
    release.mkdir(exist_ok=True)
    archive = release / archive_name(platform, arch)
    if platform == 'win32':
        with zipfile.ZipFile(archive, 'x', zipfile.ZIP_DEFLATED) as output:
            for path in sorted(bundle.rglob('*')):
                if path.is_file():
                    output.write(path, path.relative_to(bundle.parent).as_posix())
    else:
        with tarfile.open(archive, 'x:gz') as output:
            output.add(bundle, arcname=bundle.name)
    metadata['archive'] = {'name': archive.name, 'sha256': digest(archive.read_bytes()), 'size': archive.stat().st_size}
    write_json(release / f'{platform}-{arch}.json', metadata)
    if (platform, arch) == ('linux', 'x64'):
        exported = work / 'aria2-source.tar'
        subprocess.run(['git', '-c', f'safe.directory={upstream}', '-C', str(upstream), 'archive',
                        '--format=tar', f'--output={exported}', os.environ['ARIA2_COMMIT']], check=True)
        with tarfile.open(release / 'aria2-sources.tar.gz', 'x:gz') as output:
            output.add(exported, arcname='aria2-source.tar')
            for path in sorted((work / 'downloads').iterdir()):
                output.add(path, arcname='dependencies/' + path.name)
            for path in sorted((work / 'runtime-notices').iterdir()):
                output.add(path, arcname='runtime-notices/' + path.name)
            for directory, directories, files in os.walk(ROOT):
                directories[:] = sorted(name for name in directories if name not in ('.git', '.work', 'release', '__pycache__'))
                for name in sorted(files):
                    path = Path(directory) / name
                    output.add(path, arcname='builder/' + path.relative_to(ROOT).as_posix())
            data = json.dumps(source_metadata(), indent=4).encode()
            info = tarfile.TarInfo('build.json')
            info.size = len(data)
            output.addfile(info, io.BytesIO(data))
    print(json.dumps(metadata, indent=2))


def verify():
    platform, arch = target()
    release = ROOT / 'release'
    metadata = json.loads((release / f'{platform}-{arch}.json').read_text(encoding='utf-8'))
    for key, expected in [('recipe', os.environ['BUILD_RECIPE']), ('builderCommit', os.environ['BUILDER_COMMIT'])]:
        if metadata[key] != expected:
            raise ValueError(f'Package has wrong {key}')
    if metadata['upstream']['commit'] != os.environ['ARIA2_COMMIT'] or metadata['target'] != {'platform': platform, 'arch': arch}:
        raise ValueError('Package has wrong upstream commit or target')
    archive = release / archive_name(platform, arch)
    if metadata['archive'] != {'name': archive.name, 'sha256': digest(archive.read_bytes()), 'size': archive.stat().st_size}:
        raise ValueError('Package archive verification failed')
    destination = ROOT / '.work' / 'verify'
    destination.mkdir(parents=True)
    if platform == 'win32':
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                safe_name(member.filename)
                if (member.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError('Unexpected ZIP symlink')
            bundle.extractall(destination)
    else:
        with tarfile.open(archive) as bundle:
            for member in bundle.getmembers():
                safe_name(member.name)
                if not (member.isdir() or member.isfile()):
                    raise ValueError('Unexpected package link or special file')
            bundle.extractall(destination, filter='data')
    directory = destination / f'aria2-bin-{platform}-{arch}'
    binary = directory / ('aria2c.exe' if platform == 'win32' else 'aria2c')
    if inspect_binary(binary.read_bytes(), platform, arch) != metadata['binary']:
        raise ValueError('Extracted binary identity differs from build metadata')
    embedded = json.loads((directory / 'build.json').read_text(encoding='utf-8'))
    if embedded != {key: value for key, value in metadata.items() if key != 'archive'}:
        raise ValueError('Embedded package metadata differs from the manifest')
    if not list((directory / 'licenses').rglob('*')):
        raise ValueError('Package contains no license notices')
    print(f'Verified {archive.name}: {metadata["binary"]["sha256"]}')


if __name__ == '__main__':
    commands = {'fetch': fetch, 'package': package, 'verify': verify}
    if len(sys.argv) != 2 or sys.argv[1] not in commands:
        raise SystemExit('Usage: python scripts/inputs.py fetch|package|verify')
    commands[sys.argv[1]]()